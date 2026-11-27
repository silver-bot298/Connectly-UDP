"""
Datagram UDP Server (SOCK_DGRAM)
Routes JSON datagrams between connected clients, maintains heartbeat-based
presence registry, persists chat messages and datagram logs to SQLite,
and handles malformed packets without crashing.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Ensure sibling imports work whether run as `python backend/udp_server.py` or `python udp_server.py`
sys.path.insert(0, str(Path(__file__).resolve().parent))

from database import DatagramDatabase, utc_now_iso

MAX_DATAGRAM_BYTES = 1400
RECV_BUFFER_BYTES = 65535
HEARTBEAT_TIMEOUT_SECONDS = 14.0
REAPER_INTERVAL_SECONDS = 2.0


class DatagramUDPServer:
    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 9001,
        db_path: Optional[str] = None,
    ) -> None:
        self.host = host
        self.port = port
        self.db = DatagramDatabase(db_path)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((self.host, self.port))
        self.sock.settimeout(0.5)

        self._lock = threading.RLock()
        self._peers: Dict[str, Dict[str, Any]] = {}
        self._running = False
        self._stats = {
            "datagrams_received": 0,
            "datagrams_sent": 0,
            "malformed_packets": 0,
            "oversized_packets": 0,
            "voice_frames_routed": 0,
            "started_at": utc_now_iso(),
        }

    def _log(self, msg: str) -> None:
        print(f"[UDP-SERVER {utc_now_iso()}] {msg}", flush=True)

    def _send_json(self, payload: Dict[str, Any], addr: Tuple[str, int]) -> int:
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.sock.sendto(raw, addr)
        with self._lock:
            self._stats["datagrams_sent"] += 1
        return len(raw)

    def _send_error(
        self,
        addr: Tuple[str, int],
        reason: str,
        recipient: Optional[str] = None,
        message_id: Optional[str] = None,
    ) -> None:
        packet = {
            "type": "error",
            "sender": "udp_server",
            "recipient": recipient or "",
            "message": reason,
            "message_id": message_id or "",
            "timestamp": utc_now_iso(),
        }
        try:
            size = self._send_json(packet, addr)
            self._log(f"OUT -> {addr[0]}:{addr[1]} type=error bytes={size} reason={reason}")
        except OSError as exc:
            self._log(f"Failed sending error datagram to {addr}: {exc}")

    def _online_usernames(self) -> List[str]:
        with self._lock:
            return sorted(self._peers.keys())

    def _online_peer_details(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [
                {
                    "username": uname,
                    "ip": info["addr"][0],
                    "port": info["addr"][1],
                    "connected_at": info["connected_at"],
                }
                for uname, info in sorted(self._peers.items())
            ]

    def _broadcast_presence(self, target_addr: Optional[Tuple[str, int]] = None) -> None:
        packet = {
            "type": "presence",
            "sender": "udp_server",
            "online_users": self._online_usernames(),
            "peers": self._online_peer_details(),
            "server_stats": self._snapshot_stats(),
            "timestamp": utc_now_iso(),
        }
        if target_addr is not None:
            try:
                self._send_json(packet, target_addr)
            except OSError:
                pass
            return

        with self._lock:
            targets = [(uname, info["addr"]) for uname, info in self._peers.items()]
        for uname, addr in targets:
            try:
                self._send_json(packet, addr)
            except OSError as exc:
                self._log(f"Presence broadcast failed for {uname} ({addr}): {exc}")

    def _snapshot_stats(self) -> Dict[str, Any]:
        with self._lock:
            return {
                **self._stats,
                "active_peers": len(self._peers),
                "bind_host": self.host,
                "bind_port": self.port,
            }

    def _handle_packet(self, data: bytes, addr: Tuple[str, int]) -> None:
        src_str = f"{addr[0]}:{addr[1]}"
        payload_bytes = len(data)
        with self._lock:
            self._stats["datagrams_received"] += 1

        if payload_bytes > MAX_DATAGRAM_BYTES:
            with self._lock:
                self._stats["oversized_packets"] += 1
            self._log(
                f"DROP <- {src_str} oversized datagram ({payload_bytes} B > {MAX_DATAGRAM_BYTES} B limit)"
            )
            self.db.log_datagram(
                direction="IN_DROP",
                packet_type="oversized",
                sender=None,
                recipient=None,
                src_addr=src_str,
                dst_addr=f"{self.host}:{self.port}",
                message_id=None,
                payload_bytes=payload_bytes,
                note=f"Exceeded {MAX_DATAGRAM_BYTES} B UDP payload limit",
            )
            self._send_error(
                addr,
                f"Datagram payload ({payload_bytes} B) exceeds {MAX_DATAGRAM_BYTES} B practical UDP limit.",
            )
            return

        try:
            packet = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            with self._lock:
                self._stats["malformed_packets"] += 1
            self._log(f"DROP <- {src_str} malformed JSON datagram: {exc}")
            self.db.log_datagram(
                direction="IN_DROP",
                packet_type="malformed",
                sender=None,
                recipient=None,
                src_addr=src_str,
                dst_addr=f"{self.host}:{self.port}",
                message_id=None,
                payload_bytes=payload_bytes,
                note=f"Malformed JSON: {exc}",
            )
            self._send_error(addr, "Malformed JSON datagram discarded by UDP server.")
            return

        if not isinstance(packet, dict) or not isinstance(packet.get("type"), str):
            with self._lock:
                self._stats["malformed_packets"] += 1
            self._log(f"DROP <- {src_str} missing packet 'type'")
            self._send_error(addr, "Invalid datagram structure: missing 'type'.")
            return

        ptype = packet["type"]
        sender = str(packet.get("sender", "")).strip().lower()
        recipient = str(packet.get("recipient", "")).strip().lower()
        message_id = str(packet.get("message_id", "")).strip() or None

        if ptype == "register":
            if not sender:
                self._send_error(addr, "Register datagram requires 'sender'.")
                return
            with self._lock:
                self._peers[sender] = {
                    "addr": addr,
                    "last_seen": time.monotonic(),
                    "connected_at": utc_now_iso(),
                }
            self._log(f"IN  <- {src_str} type=register sender={sender} bytes={payload_bytes}")
            self.db.log_datagram(
                direction="IN",
                packet_type="register",
                sender=sender,
                recipient="udp_server",
                src_addr=src_str,
                dst_addr=f"{self.host}:{self.port}",
                message_id=message_id,
                payload_bytes=payload_bytes,
                note=f"Peer registered at {src_str}",
            )
            self._broadcast_presence()
            return

        if ptype == "heartbeat":
            if not sender:
                return
            is_new_or_changed = False
            with self._lock:
                existing = self._peers.get(sender)
                if not existing:
                    self._peers[sender] = {
                        "addr": addr,
                        "last_seen": time.monotonic(),
                        "connected_at": utc_now_iso(),
                    }
                    is_new_or_changed = True
                else:
                    if existing["addr"] != addr:
                        is_new_or_changed = True
                    existing["addr"] = addr
                    existing["last_seen"] = time.monotonic()
            self._log(f"IN  <- {src_str} type=heartbeat sender={sender} bytes={payload_bytes}")
            self.db.log_datagram(
                direction="IN",
                packet_type="heartbeat",
                sender=sender,
                recipient="udp_server",
                src_addr=src_str,
                dst_addr=f"{self.host}:{self.port}",
                message_id=message_id,
                payload_bytes=payload_bytes,
                note="Keepalive heartbeat",
            )
            if is_new_or_changed:
                self._broadcast_presence()
            else:
                self._broadcast_presence(target_addr=addr)
            return

        if ptype == "disconnect":
            if sender:
                removed = False
                with self._lock:
                    if sender in self._peers:
                        del self._peers[sender]
                        removed = True
                self._log(f"IN  <- {src_str} type=disconnect sender={sender} bytes={payload_bytes}")
                self.db.log_datagram(
                    direction="IN",
                    packet_type="disconnect",
                    sender=sender,
                    recipient="udp_server",
                    src_addr=src_str,
                    dst_addr=f"{self.host}:{self.port}",
                    message_id=message_id,
                    payload_bytes=payload_bytes,
                    note="Explicit disconnect datagram",
                )
                if removed:
                    self._broadcast_presence()
            return

        if ptype == "presence":
            self._broadcast_presence(target_addr=addr)
            return

        if ptype == "chat_message":
            content = packet.get("message")
            timestamp = str(packet.get("timestamp") or utc_now_iso())
            retry_count = int(packet.get("retry_count") or 0)
            seq_num = int(packet.get("seq_num") or 0)

            if not sender or not recipient or not isinstance(content, str) or not message_id:
                self._send_error(
                    addr,
                    "chat_message requires sender, recipient, message, and message_id.",
                    recipient=sender,
                    message_id=message_id,
                )
                return

            # Refresh sender activity
            with self._lock:
                if sender in self._peers:
                    self._peers[sender]["addr"] = addr
                    self._peers[sender]["last_seen"] = time.monotonic()
                target_peer = self._peers.get(recipient)

            self._log(
                f"IN  <- {src_str} type=chat_message sender={sender} recipient={recipient} id={message_id} bytes={payload_bytes}"
            )
            self.db.log_datagram(
                direction="IN",
                packet_type="chat_message",
                sender=sender,
                recipient=recipient,
                src_addr=src_str,
                dst_addr=f"{self.host}:{self.port}",
                message_id=message_id,
                payload_bytes=payload_bytes,
                note=f"seq={seq_num} retry={retry_count}",
            )

            self.db.save_message(
                message_id=message_id,
                sender=sender,
                recipient=recipient,
                content=content,
                timestamp=timestamp,
                status="sent",
                retry_count=retry_count,
                datagram_bytes=payload_bytes,
                seq_num=seq_num,
            )

            if target_peer is not None:
                dst_addr = target_peer["addr"]
                dst_str = f"{dst_addr[0]}:{dst_addr[1]}"
                try:
                    sent_bytes = self._send_json(packet, dst_addr)
                    self._log(
                        f"OUT -> {dst_str} type=chat_message sender={sender} recipient={recipient} id={message_id} bytes={sent_bytes}"
                    )
                    self.db.log_datagram(
                        direction="OUT",
                        packet_type="chat_message",
                        sender=sender,
                        recipient=recipient,
                        src_addr=f"{self.host}:{self.port}",
                        dst_addr=dst_str,
                        message_id=message_id,
                        payload_bytes=sent_bytes,
                        note=f"Routed to {recipient} ({dst_str})",
                    )
                except OSError as exc:
                    self._send_error(
                        addr,
                        f"UDP socket send failed to {recipient}: {exc}",
                        recipient=sender,
                        message_id=message_id,
                    )
            else:
                self._log(
                    f"INFO   recipient={recipient} is offline; chat_message id={message_id} stored in SQLite without live UDP route"
                )
                self._send_error(
                    addr,
                    f"Peer '{recipient}' is offline (no active UDP address registered). Message saved in history; no live UDP ACK possible.",
                    recipient=sender,
                    message_id=message_id,
                )
            return

        if ptype == "message_ack":
            if not sender or not recipient or not message_id:
                return
            self.db.update_message_status(message_id=message_id, status="delivered")
            with self._lock:
                target_peer = self._peers.get(recipient)
            self._log(
                f"IN  <- {src_str} type=message_ack sender={sender} recipient={recipient} id={message_id} bytes={payload_bytes}"
            )
            self.db.log_datagram(
                direction="IN",
                packet_type="message_ack",
                sender=sender,
                recipient=recipient,
                src_addr=src_str,
                dst_addr=f"{self.host}:{self.port}",
                message_id=message_id,
                payload_bytes=payload_bytes,
                note="Application-layer delivery ACK",
            )
            if target_peer is not None:
                dst_addr = target_peer["addr"]
                dst_str = f"{dst_addr[0]}:{dst_addr[1]}"
                try:
                    sent_bytes = self._send_json(packet, dst_addr)
                    self._log(
                        f"OUT -> {dst_str} type=message_ack sender={sender} recipient={recipient} id={message_id} bytes={sent_bytes}"
                    )
                    self.db.log_datagram(
                        direction="OUT",
                        packet_type="message_ack",
                        sender=sender,
                        recipient=recipient,
                        src_addr=f"{self.host}:{self.port}",
                        dst_addr=dst_str,
                        message_id=message_id,
                        payload_bytes=sent_bytes,
                        note=f"ACK forwarded to {recipient}",
                    )
                except OSError:
                    pass
            return

        if ptype == "typing":
            if not sender or not recipient:
                return
            with self._lock:
                target_peer = self._peers.get(recipient)
            if target_peer is not None:
                dst_addr = target_peer["addr"]
                try:
                    self._send_json(packet, dst_addr)
                except OSError:
                    pass
            return

        if ptype in ("call_invite", "call_answer", "call_end"):
            call_id = str(packet.get("call_id", "")).strip()
            if not sender or not recipient or not call_id:
                self._send_error(addr, f"{ptype} requires sender, recipient, and call_id.")
                return
            with self._lock:
                if sender in self._peers:
                    self._peers[sender]["addr"] = addr
                    self._peers[sender]["last_seen"] = time.monotonic()
                target_peer = self._peers.get(recipient)

            self._log(
                f"IN  <- {src_str} type={ptype} sender={sender} recipient={recipient} call_id={call_id} bytes={payload_bytes}"
            )
            self.db.log_datagram(
                direction="IN",
                packet_type=ptype,
                sender=sender,
                recipient=recipient,
                src_addr=src_str,
                dst_addr=f"{self.host}:{self.port}",
                message_id=call_id,
                payload_bytes=payload_bytes,
                note=f"Voice signaling ({ptype})",
            )

            if target_peer is not None:
                dst_addr = target_peer["addr"]
                try:
                    sent_bytes = self._send_json(packet, dst_addr)
                    self.db.log_datagram(
                        direction="OUT",
                        packet_type=ptype,
                        sender=sender,
                        recipient=recipient,
                        src_addr=f"{self.host}:{self.port}",
                        dst_addr=f"{dst_addr[0]}:{dst_addr[1]}",
                        message_id=call_id,
                        payload_bytes=sent_bytes,
                        note=f"Routed {ptype} to {recipient}",
                    )
                except OSError as exc:
                    self._send_error(addr, f"Failed routing {ptype}: {exc}", recipient=sender)
            else:
                if ptype == "call_invite":
                    self._send_error(
                        addr,
                        f"Peer '{recipient}' is offline and cannot receive UDP voice calls.",
                        recipient=sender,
                        message_id=call_id,
                    )
            return

        if ptype == "voice_frame":
            if not sender or not recipient:
                return
            with self._lock:
                if sender in self._peers:
                    self._peers[sender]["last_seen"] = time.monotonic()
                target_peer = self._peers.get(recipient)
            if target_peer is not None:
                try:
                    self._send_json(packet, target_peer["addr"])
                    with self._lock:
                        self._stats["voice_frames_routed"] += 1
                except OSError:
                    pass
            return

        self._send_error(addr, f"Unsupported datagram type '{ptype}'.")

    def _reaper_loop(self) -> None:
        while self._running:
            time.sleep(REAPER_INTERVAL_SECONDS)
            now = time.monotonic()
            expired: List[str] = []
            with self._lock:
                for uname, info in list(self._peers.items()):
                    if now - info["last_seen"] > HEARTBEAT_TIMEOUT_SECONDS:
                        expired.append(uname)
                        del self._peers[uname]
            if expired:
                self._log(f"Heartbeat timeout expired for peers: {', '.join(expired)}")
                self._broadcast_presence()

    def serve_forever(self) -> None:
        self._running = True
        reaper = threading.Thread(target=self._reaper_loop, daemon=True)
        reaper.start()
        self._log(
            f"UDP server listening on {self.host}:{self.port} (AF_INET, SOCK_DGRAM, MTU limit={MAX_DATAGRAM_BYTES} B)"
        )
        try:
            while self._running:
                try:
                    data, addr = self.sock.recvfrom(RECV_BUFFER_BYTES)
                    self._handle_packet(data, addr)
                except socket.timeout:
                    continue
                except OSError as exc:
                    if self._running:
                        self._log(f"Socket error: {exc}")
                    break
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        if not self._running:
            try:
                self.sock.close()
            except OSError:
                pass
            return
        self._running = False
        self._log("Shutting down UDP server cleanly...")
        try:
            self.sock.close()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Datagram UDP Server (SOCK_DGRAM)")
    parser.add_argument(
        "--host",
        default=os.environ.get("DATAGRAM_UDP_HOST", "0.0.0.0"),
        help="UDP bind host (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("DATAGRAM_UDP_PORT", "9001")),
        help="UDP bind port (default: 9001)",
    )
    args = parser.parse_args()

    server = DatagramUDPServer(host=args.host, port=args.port)

    def _signal_handler(signum: int, _frame: Any) -> None:
        server._log(f"Received signal {signum}")
        server.shutdown()

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
