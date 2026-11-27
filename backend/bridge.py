"""
Datagram Python Client Bridge (HTTP + RFC 6455 WebSocket -> UDP Client)
Allows browser React clients to authenticate over lightweight HTTP and communicate
in real time over WebSockets while every chat message, typing indicator, heartbeat,
and acknowledgement travels over real OS-level IPv4 UDP datagrams (SOCK_DGRAM).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import signal
import struct
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth import (
    create_session_token,
    hash_password,
    validate_full_name,
    validate_password,
    validate_username,
    verify_password,
    verify_session_token,
)
from database import DatagramDatabase
from udp_client import DatagramUDPClient

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

DEFAULT_AVATARS = [
    "/src/assets/images/avatar_portrait_one_1795788836099.jpg",
    "/src/assets/images/avatar_portrait_two_1795788838122.jpg",
    "/src/assets/images/avatar_portrait_three_1795788838243.jpg",
    "monogram",
]


def _encode_ws_frame(payload_bytes: bytes, opcode: int = 0x1) -> bytes:
    header = bytearray()
    header.append(0x80 | (opcode & 0x0F))
    length = len(payload_bytes)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + payload_bytes


async def _read_ws_frame(reader: asyncio.StreamReader) -> Tuple[int, bytes]:
    b1, b2 = await reader.readexactly(2)
    fin = (b1 & 0x80) != 0
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F

    if length == 126:
        (length,) = struct.unpack("!H", await reader.readexactly(2))
    elif length == 127:
        (length,) = struct.unpack("!Q", await reader.readexactly(8))

    if length > 1024 * 1024:
        raise ValueError("WebSocket frame too large")

    mask_key = await reader.readexactly(4) if masked else b""
    payload = bytearray(await reader.readexactly(length))
    if masked:
        for i in range(length):
            payload[i] ^= mask_key[i % 4]

    # Handle continuation frames if client fragments a message
    if not fin and opcode != 0x8:
        while True:
            nb1, nb2 = await reader.readexactly(2)
            nfin = (nb1 & 0x80) != 0
            nmasked = (nb2 & 0x80) != 0
            nlen = nb2 & 0x7F
            if nlen == 126:
                (nlen,) = struct.unpack("!H", await reader.readexactly(2))
            elif nlen == 127:
                (nlen,) = struct.unpack("!Q", await reader.readexactly(8))
            nmask = await reader.readexactly(4) if nmasked else b""
            npayload = bytearray(await reader.readexactly(nlen))
            if nmasked:
                for i in range(nlen):
                    npayload[i] ^= nmask[i % 4]
            payload.extend(npayload)
            if nfin:
                break

    return opcode, bytes(payload)


class BridgeServer:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8765,
        udp_host: str = "127.0.0.1",
        udp_port: int = 9001,
    ) -> None:
        self.host = host
        self.port = port
        self.udp_host = udp_host
        self.udp_port = udp_port
        self.db = DatagramDatabase()
        self.active_clients: Dict[str, Set[DatagramUDPClient]] = {}
        self.latest_online_users: Set[str] = set()
        self._server: Optional[asyncio.AbstractServer] = None

    def _log(self, msg: str) -> None:
        print(f"[BRIDGE] {msg}", flush=True)

    def _auth_user_from_headers(self, headers: Dict[str, str]) -> Optional[Dict[str, Any]]:
        auth_header = headers.get("authorization", "")
        if not auth_header.lower().startswith("bearer "):
            return None
        token = auth_header[7:].strip()
        payload = verify_session_token(token)
        if not payload:
            return None
        username = str(payload.get("sub", ""))
        return self.db.get_user(username)

    def _current_online_set(self) -> Set[str]:
        online = set(self.latest_online_users)
        for uname, clients in self.active_clients.items():
            if clients:
                online.add(uname)
        return online

    async def _send_http_json(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        data: Any,
        reason: str = "OK",
    ) -> None:
        body = json.dumps(data).encode("utf-8")
        headers = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"Content-Type: application/json; charset=utf-8\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Cache-Control: no-store\r\n"
            f"Connection: close\r\n\r\n"
        ).encode("ascii")
        writer.write(headers + body)
        await writer.drain()
        writer.close()

    async def _handle_http(
        self,
        method: str,
        raw_target: str,
        headers: Dict[str, str],
        body_bytes: bytes,
        writer: asyncio.StreamWriter,
    ) -> None:
        parsed = urlparse(raw_target)
        path = parsed.path

        if method == "OPTIONS":
            resp = (
                "HTTP/1.1 204 No Content\r\n"
                "Access-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\n"
                "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
                "Connection: close\r\n\r\n"
            ).encode("ascii")
            writer.write(resp)
            await writer.drain()
            writer.close()
            return

        if method == "GET" and path == "/api/health":
            await self._send_http_json(
                writer,
                200,
                {
                    "ok": True,
                    "udp_server": f"{self.udp_host}:{self.udp_port}",
                    "active_bridge_sessions": sum(len(v) for v in self.active_clients.values()),
                },
            )
            return

        if method == "POST" and path == "/api/auth/register":
            try:
                body = json.loads(body_bytes.decode("utf-8") or "{}")
                username = validate_username(str(body.get("username", "")))
                full_name = validate_full_name(str(body.get("full_name", "")))
                password = validate_password(str(body.get("password", "")))
                confirm = str(body.get("confirm_password", password))
                if password != confirm:
                    await self._send_http_json(
                        writer, 400, {"error": "Passwords do not match."}, "Bad Request"
                    )
                    return

                avatar_url = str(body.get("avatar_url") or DEFAULT_AVATARS[0])
                if avatar_url not in DEFAULT_AVATARS:
                    avatar_url = "monogram"

                if self.db.get_user_with_hash(username):
                    await self._send_http_json(
                        writer,
                        409,
                        {"error": f"Username '@{username}' is already taken."},
                        "Conflict",
                    )
                    return

                pw_hash = hash_password(password)
                user = self.db.create_user(username, full_name, pw_hash, avatar_url)
                token = create_session_token(username)
                await self._send_http_json(writer, 201, {"token": token, "user": user}, "Created")
            except ValueError as exc:
                await self._send_http_json(writer, 400, {"error": str(exc)}, "Bad Request")
            except Exception as exc:
                await self._send_http_json(writer, 500, {"error": str(exc)}, "Internal Error")
            return

        if method == "POST" and path == "/api/auth/login":
            try:
                body = json.loads(body_bytes.decode("utf-8") or "{}")
                username = str(body.get("username", "")).strip().lower()
                password = str(body.get("password", ""))
                record = self.db.get_user_with_hash(username)
                if not record or not verify_password(password, record["password_hash"]):
                    await self._send_http_json(
                        writer,
                        401,
                        {"error": "Invalid username or password."},
                        "Unauthorized",
                    )
                    return
                user = {
                    "username": record["username"],
                    "full_name": record["full_name"],
                    "avatar_url": record["avatar_url"],
                    "created_at": record["created_at"],
                }
                token = create_session_token(username)
                await self._send_http_json(writer, 200, {"token": token, "user": user})
            except Exception as exc:
                await self._send_http_json(writer, 400, {"error": str(exc)}, "Bad Request")
            return

        # Authenticated endpoints below
        user = self._auth_user_from_headers(headers)
        if not user:
            await self._send_http_json(writer, 401, {"error": "Unauthorized."}, "Unauthorized")
            return

        if method == "GET" and path == "/api/auth/me":
            await self._send_http_json(writer, 200, {"user": user})
            return

        if method == "PUT" and path == "/api/profile":
            try:
                body = json.loads(body_bytes.decode("utf-8") or "{}")
                full_name = validate_full_name(str(body.get("full_name", user["full_name"])))
                avatar_url = str(body.get("avatar_url") or user["avatar_url"])
                if avatar_url not in DEFAULT_AVATARS:
                    avatar_url = "monogram"
                updated = self.db.update_user_profile(user["username"], full_name, avatar_url)
                await self._send_http_json(writer, 200, {"user": updated})
            except ValueError as exc:
                await self._send_http_json(writer, 400, {"error": str(exc)}, "Bad Request")
            return

        if method == "GET" and path == "/api/users":
            all_users = self.db.list_users()
            recent = {
                r["peer"]: r for r in self.db.get_recent_conversations_for(user["username"])
            }
            online_set = self._current_online_set()
            peers = []
            for u in all_users:
                if u["username"] == user["username"]:
                    continue
                rec = recent.get(u["username"])
                peers.append(
                    {
                        **u,
                        "online": u["username"] in online_set,
                        "last_message": rec["last_message"] if rec else None,
                        "last_timestamp": rec["last_timestamp"] if rec else None,
                        "last_sender": rec["last_sender"] if rec else None,
                        "last_status": rec["last_status"] if rec else None,
                    }
                )
            await self._send_http_json(writer, 200, {"users": peers})
            return

        if method == "GET" and path.startswith("/api/messages/"):
            peer = unquote(path[len("/api/messages/") :]).strip().lower()
            if not peer:
                await self._send_http_json(writer, 400, {"error": "Peer required."}, "Bad Request")
                return
            msgs = self.db.get_conversation(user["username"], peer)
            await self._send_http_json(writer, 200, {"messages": msgs})
            return

        if method == "GET" and path == "/api/diagnostics/logs":
            logs = self.db.get_recent_logs(100)
            await self._send_http_json(writer, 200, {"logs": logs})
            return

        await self._send_http_json(writer, 404, {"error": "Not found."}, "Not Found")

    async def _handle_websocket(
        self,
        raw_target: str,
        headers: Dict[str, str],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        ws_key = headers.get("sec-websocket-key")
        if not ws_key:
            writer.close()
            return

        accept_raw = hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()
        accept_b64 = base64.b64encode(accept_raw).decode("ascii")
        handshake = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_b64}\r\n\r\n"
        ).encode("ascii")
        writer.write(handshake)
        await writer.drain()

        loop = asyncio.get_running_loop()
        send_queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue()

        # Verify token from query parameter
        parsed = urlparse(raw_target)
        query_params = parse_qs(parsed.query)
        token = (query_params.get("token") or [""])[0]
        token_payload = verify_session_token(token)
        user = (
            self.db.get_user(str(token_payload["sub"]))
            if token_payload and token_payload.get("sub")
            else None
        )

        if not user:
            err_frame = _encode_ws_frame(
                json.dumps({"event": "auth_error", "error": "Invalid or expired session."}).encode("utf-8")
            )
            writer.write(err_frame)
            writer.write(_encode_ws_frame(b"", opcode=0x8))
            await writer.drain()
            writer.close()
            return

        username = user["username"]

        def _on_udp_event(evt: Dict[str, Any]) -> None:
            if evt.get("event") == "presence":
                self.latest_online_users = set(evt.get("online_users") or [])
            loop.call_soon_threadsafe(send_queue.put_nowait, evt)

        udp_client = DatagramUDPClient(
            username=username,
            server_host=self.udp_host,
            server_port=self.udp_port,
            on_event=_on_udp_event,
            db=self.db,
        )
        self.active_clients.setdefault(username, set()).add(udp_client)
        udp_client.start()
        self._log(
            f"WS session opened for @{username} -> UDP SOCK_DGRAM bound on local port {udp_client.source_port}"
        )

        # Push initial diagnostics snapshot
        await send_queue.put({"event": "diagnostics", "diagnostics": udp_client.get_diagnostics()})

        async def _writer_task() -> None:
            try:
                while True:
                    evt = await send_queue.get()
                    if evt is None:
                        break
                    data = json.dumps(evt).encode("utf-8")
                    writer.write(_encode_ws_frame(data, opcode=0x1))
                    await writer.drain()
            except Exception:
                pass

        writer_coro = asyncio.create_task(_writer_task())

        try:
            while True:
                opcode, payload = await _read_ws_frame(reader)
                if opcode == 0x8:  # Close
                    break
                if opcode == 0x9:  # Ping -> Pong
                    writer.write(_encode_ws_frame(payload, opcode=0xA))
                    await writer.drain()
                    continue
                if opcode != 0x1:
                    continue

                try:
                    cmd = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue

                action = cmd.get("action")
                if action == "send_message":
                    recipient = str(cmd.get("recipient", "")).strip().lower()
                    content = str(cmd.get("message", ""))
                    if not recipient or not content.strip():
                        continue
                    try:
                        saved_msg = udp_client.send_chat_message(recipient, content)
                        await send_queue.put({"event": "message_sent", "message": saved_msg})
                    except ValueError as exc:
                        await send_queue.put({"event": "udp_error", "message": str(exc)})

                elif action == "typing":
                    recipient = str(cmd.get("recipient", "")).strip().lower()
                    if recipient:
                        udp_client.send_typing(recipient, bool(cmd.get("is_typing", False)))

                elif action == "update_config":
                    udp_client.update_config(
                        ack_enabled=cmd.get("ack_enabled"),
                        retry_enabled=cmd.get("retry_enabled"),
                        max_retries=cmd.get("max_retries"),
                        packet_loss_rate=cmd.get("packet_loss_rate"),
                    )

                elif action == "send_duplicate_test":
                    recipient = str(cmd.get("recipient", "")).strip().lower()
                    content = str(cmd.get("message") or "UDP Duplicate Detection Test Packet")
                    if recipient:
                        msg = udp_client.send_duplicate_test(recipient, content)
                        await send_queue.put({"event": "message_sent", "message": msg})

                elif action == "send_reorder_burst":
                    recipient = str(cmd.get("recipient", "")).strip().lower()
                    if recipient:
                        msgs = udp_client.send_reorder_burst(recipient)
                        for m in msgs:
                            await send_queue.put({"event": "message_sent", "message": m})

                elif action == "send_oversized_test":
                    recipient = str(cmd.get("recipient", "")).strip().lower() or username
                    udp_client.send_oversized_test(recipient)

                elif action == "request_diagnostics":
                    await send_queue.put(
                        {"event": "diagnostics", "diagnostics": udp_client.get_diagnostics()}
                    )

                elif action in ("call_invite", "call_answer", "call_end"):
                    recipient = str(cmd.get("recipient", "")).strip().lower()
                    call_id = str(cmd.get("call_id", "")).strip()
                    if recipient and call_id:
                        udp_client.send_call_signal(
                            signal_type=action,
                            recipient=recipient,
                            call_id=call_id,
                            accepted=cmd.get("accepted"),
                            reason=cmd.get("reason"),
                        )

                elif action == "voice_frame":
                    recipient = str(cmd.get("recipient", "")).strip().lower()
                    call_id = str(cmd.get("call_id", "")).strip()
                    seq = int(cmd.get("seq") or 0)
                    audio_b64 = str(cmd.get("audio", ""))
                    if recipient and call_id and audio_b64:
                        udp_client.send_voice_frame(recipient, call_id, seq, audio_b64)

        except (asyncio.IncompleteReadError, ConnectionResetError, OSError):
            pass
        finally:
            await send_queue.put(None)
            writer_coro.cancel()
            clients_for_user = self.active_clients.get(username)
            if clients_for_user:
                clients_for_user.discard(udp_client)
                if not clients_for_user:
                    del self.active_clients[username]
            udp_client.close()
            self._log(
                f"WS session closed for @{username} (UDP local port {udp_client.source_port} closed)"
            )
            try:
                writer.close()
            except Exception:
                pass

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            header_bytes = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
        except Exception:
            writer.close()
            return

        header_text = header_bytes.decode("latin-1")
        lines = header_text.split("\r\n")
        if not lines:
            writer.close()
            return

        parts = lines[0].split(" ")
        if len(parts) < 2:
            writer.close()
            return

        method, raw_target = parts[0].upper(), parts[1]
        headers: Dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        if headers.get("upgrade", "").lower() == "websocket":
            await self._handle_websocket(raw_target, headers, reader, writer)
            return

        content_length = int(headers.get("content-length") or 0)
        body_bytes = b""
        if content_length > 0:
            if content_length > 2 * 1024 * 1024:
                await self._send_http_json(writer, 413, {"error": "Payload too large"}, "Too Large")
                return
            body_bytes = await reader.readexactly(content_length)

        await self._handle_http(method, raw_target, headers, body_bytes, writer)

    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle_connection, self.host, self.port
        )
        self._log(
            f"Client Bridge listening on http://{self.host}:{self.port} (WS /ws + HTTP /api/* -> UDP {self.udp_host}:{self.udp_port})"
        )
        async with self._server:
            await self._server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description="Datagram Python Client Bridge")
    parser.add_argument(
        "--host", default=os.environ.get("DATAGRAM_BRIDGE_HOST", "127.0.0.1")
    )
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("DATAGRAM_BRIDGE_PORT", "8765"))
    )
    parser.add_argument(
        "--udp-host", default=os.environ.get("DATAGRAM_UDP_HOST", "127.0.0.1")
    )
    parser.add_argument(
        "--udp-port", type=int, default=int(os.environ.get("DATAGRAM_UDP_PORT", "9001"))
    )
    args = parser.parse_args()

    bridge = BridgeServer(
        host=args.host,
        port=args.port,
        udp_host=args.udp_host,
        udp_port=args.udp_port,
    )

    try:
        asyncio.run(bridge.start())
    except KeyboardInterrupt:
        print("\nBridge stopped.", flush=True)


if __name__ == "__main__":
    main()
