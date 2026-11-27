"""
Datagram UDP Client (SOCK_DGRAM)
Used by bridge.py for browser-connected clients and runnable standalone via CLI.
Implements connectionless UDP send/receive, heartbeats, application-layer ACKs,
limited-retry retransmission, duplicate detection, out-of-order tracking,
and real UDP packet-loss simulation.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import socket
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Set, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from database import DatagramDatabase, utc_now_iso

MAX_DATAGRAM_BYTES = 1400
HEARTBEAT_INTERVAL_SECONDS = 4.0


class DatagramUDPClient:
    def __init__(
        self,
        username: str,
        server_host: str = "127.0.0.1",
        server_port: int = 9001,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        db: Optional[DatagramDatabase] = None,
    ) -> None:
        self.username = username.strip().lower()
        self.server_host = server_host
        self.server_port = server_port
        self.server_addr = (self.server_host, self.server_port)
        self.on_event = on_event
        self.db = db

        # Bind ephemeral local UDP source port
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.sock.settimeout(0.4)
        self.source_port: int = self.sock.getsockname()[1]

        self._lock = threading.RLock()
        self._running = False
        self._seq_counter = 0

        # Reliability & simulation controls (application-layer toggles on top of UDP)
        self.ack_enabled: bool = True
        self.retry_enabled: bool = True
        self.max_retries: int = 3
        self.retry_interval: float = 1.5
        self.packet_loss_rate: float = 0.0  # 0.0 to 0.8

        # Tracking structures
        self._pending_acks: Dict[str, Dict[str, Any]] = {}
        self._seen_message_ids: Deque[str] = deque(maxlen=500)
        self._seen_set: Set[str] = set()
        self._last_seq_by_sender: Dict[str, int] = {}
        self._online_users: List[str] = []
        self._server_stats: Dict[str, Any] = {}
        self._recent_datagrams: Deque[Dict[str, Any]] = deque(maxlen=80)

        self.metrics: Dict[str, Any] = {
            "server_ip": self.server_host,
            "server_port": self.server_port,
            "client_source_port": self.source_port,
            "datagrams_sent": 0,
            "datagrams_received": 0,
            "acks_sent": 0,
            "acks_received": 0,
            "duplicates_detected": 0,
            "missing_acks": 0,
            "retransmissions": 0,
            "simulated_losses": 0,
            "out_of_order_count": 0,
            "voice_frames_sent": 0,
            "voice_frames_received": 0,
            "voice_out_of_order": 0,
        }
        self._last_voice_seq_by_call: Dict[str, int] = {}

    def _emit(self, event: Dict[str, Any]) -> None:
        if self.on_event:
            try:
                self.on_event(event)
            except Exception:
                pass

    def _record_datagram(
        self,
        direction: str,
        packet_type: str,
        peer: str,
        byte_len: int,
        message_id: str = "",
        status: str = "transmitted",
        note: str = "",
    ) -> None:
        entry = {
            "id": uuid.uuid4().hex[:10],
            "direction": direction,
            "type": packet_type,
            "peer": peer,
            "src_port": self.source_port if direction.startswith("OUT") else self.server_port,
            "dst_port": self.server_port if direction.startswith("OUT") else self.source_port,
            "bytes": byte_len,
            "message_id": message_id,
            "status": status,
            "note": note,
            "timestamp": utc_now_iso(),
        }
        with self._lock:
            self._recent_datagrams.appendleft(entry)
        self._emit({"event": "datagram_log", "entry": entry})

    def get_diagnostics(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "metrics": dict(self.metrics),
                "config": {
                    "ack_enabled": self.ack_enabled,
                    "retry_enabled": self.retry_enabled,
                    "max_retries": self.max_retries,
                    "packet_loss_rate": self.packet_loss_rate,
                },
                "server_stats": dict(self._server_stats),
                "online_users": list(self._online_users),
                "recent_datagrams": list(self._recent_datagrams),
            }

    def update_config(
        self,
        ack_enabled: Optional[bool] = None,
        retry_enabled: Optional[bool] = None,
        max_retries: Optional[int] = None,
        packet_loss_rate: Optional[float] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            if ack_enabled is not None:
                self.ack_enabled = bool(ack_enabled)
            if retry_enabled is not None:
                self.retry_enabled = bool(retry_enabled)
            if max_retries is not None:
                self.max_retries = max(0, min(5, int(max_retries)))
            if packet_loss_rate is not None:
                self.packet_loss_rate = max(0.0, min(0.85, float(packet_loss_rate)))
        diag = self.get_diagnostics()
        self._emit({"event": "diagnostics", "diagnostics": diag})
        return diag

    def _raw_send(self, packet: Dict[str, Any], allow_loss_sim: bool = False) -> Tuple[bool, int]:
        raw = json.dumps(packet, separators=(",", ":")).encode("utf-8")
        byte_len = len(raw)
        if byte_len > MAX_DATAGRAM_BYTES:
            raise ValueError(
                f"Datagram size {byte_len} B exceeds practical {MAX_DATAGRAM_BYTES} B UDP limit."
            )

        ptype = str(packet.get("type", ""))
        peer = str(packet.get("recipient", "") or "udp_server")
        msg_id = str(packet.get("message_id", ""))

        if allow_loss_sim and self.packet_loss_rate > 0.0:
            if random.random() < self.packet_loss_rate:
                with self._lock:
                    self.metrics["simulated_losses"] += 1
                self._record_datagram(
                    direction="OUT_LOST",
                    packet_type=ptype,
                    peer=peer,
                    byte_len=byte_len,
                    message_id=msg_id,
                    status="dropped_sim",
                    note=f"Simulated UDP packet loss ({int(self.packet_loss_rate * 100)}%)",
                )
                return False, byte_len

        self.sock.sendto(raw, self.server_addr)
        with self._lock:
            self.metrics["datagrams_sent"] += 1
        self._record_datagram(
            direction="OUT",
            packet_type=ptype,
            peer=peer,
            byte_len=byte_len,
            message_id=msg_id,
            status="sent",
            note=f"seq={packet.get('seq_num', '-')}" if ptype == "chat_message" else "",
        )
        return True, byte_len

    def start(self) -> None:
        self._running = True
        threading.Thread(target=self._recv_loop, daemon=True).start()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()
        threading.Thread(target=self._retry_loop, daemon=True).start()
        self.register()

    def register(self) -> None:
        packet = {
            "type": "register",
            "sender": self.username,
            "recipient": "udp_server",
            "timestamp": utc_now_iso(),
        }
        try:
            self._raw_send(packet)
        except OSError:
            pass

    def send_typing(self, recipient: str, is_typing: bool) -> None:
        packet = {
            "type": "typing",
            "sender": self.username,
            "recipient": recipient.strip().lower(),
            "is_typing": bool(is_typing),
            "timestamp": utc_now_iso(),
        }
        try:
            self._raw_send(packet)
        except OSError:
            pass

    def send_chat_message(
        self,
        recipient: str,
        message: str,
        message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        clean_recipient = recipient.strip().lower()
        msg_id = message_id or uuid.uuid4().hex[:12]
        timestamp = utc_now_iso()

        with self._lock:
            self._seq_counter += 1
            seq_num = self._seq_counter

        packet = {
            "type": "chat_message",
            "sender": self.username,
            "recipient": clean_recipient,
            "message": message,
            "message_id": msg_id,
            "seq_num": seq_num,
            "retry_count": 0,
            "timestamp": timestamp,
        }

        raw_preview = json.dumps(packet, separators=(",", ":")).encode("utf-8")
        byte_len = len(raw_preview)
        if byte_len > MAX_DATAGRAM_BYTES:
            raise ValueError(
                f"Message datagram ({byte_len} B) exceeds {MAX_DATAGRAM_BYTES} B UDP MTU limit. Shorten the message."
            )

        if self.db:
            self.db.save_message(
                message_id=msg_id,
                sender=self.username,
                recipient=clean_recipient,
                content=message,
                timestamp=timestamp,
                status="sent",
                retry_count=0,
                datagram_bytes=byte_len,
                seq_num=seq_num,
            )

        # Register pending ACK tracker if ACKs are expected
        if self.ack_enabled:
            with self._lock:
                self._pending_acks[msg_id] = {
                    "packet": dict(packet),
                    "attempts": 0,
                    "last_attempt": time.monotonic(),
                    "max_retries": self.max_retries if self.retry_enabled else 0,
                }

        sent_ok, actual_bytes = self._raw_send(packet, allow_loss_sim=True)
        status = "sent" if sent_ok else "dropped_sim"
        if not sent_ok and self.db and not self.retry_enabled:
            self.db.update_message_status(msg_id, "unacknowledged")
            with self._lock:
                self.metrics["missing_acks"] += 1
                self._pending_acks.pop(msg_id, None)

        self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})
        return {
            "message_id": msg_id,
            "sender": self.username,
            "recipient": clean_recipient,
            "content": message,
            "timestamp": timestamp,
            "status": status,
            "retry_count": 0,
            "datagram_bytes": actual_bytes,
            "seq_num": seq_num,
        }

    def send_duplicate_test(self, recipient: str, content: str) -> Dict[str, Any]:
        """Transmits the exact same message_id twice over UDP to demonstrate duplicate detection."""
        msg_id = f"dup-{uuid.uuid4().hex[:8]}"
        first = self.send_chat_message(recipient=recipient, message=content, message_id=msg_id)
        # Transmit duplicate datagram with identical message_id directly over UDP
        dup_packet = {
            "type": "chat_message",
            "sender": self.username,
            "recipient": recipient.strip().lower(),
            "message": content,
            "message_id": msg_id,
            "seq_num": first["seq_num"],
            "retry_count": 1,
            "timestamp": first["timestamp"],
        }
        try:
            self._raw_send(dup_packet, allow_loss_sim=False)
        except OSError:
            pass
        return first

    def send_reorder_burst(self, recipient: str) -> List[Dict[str, Any]]:
        """
        Demonstrates out-of-order UDP delivery: allocates seq N and seq N+1,
        sends seq N+1 immediately and delays seq N by 120ms in a background thread.
        """
        clean_recipient = recipient.strip().lower()
        with self._lock:
            seq_first = self._seq_counter + 1
            seq_second = self._seq_counter + 2
            self._seq_counter += 2

        ts1 = utc_now_iso()
        ts2 = utc_now_iso()
        id1 = f"ord-{uuid.uuid4().hex[:8]}"
        id2 = f"ord-{uuid.uuid4().hex[:8]}"

        pkt1 = {
            "type": "chat_message",
            "sender": self.username,
            "recipient": clean_recipient,
            "message": f"[Order Test #1 · seq={seq_first}] Sent first, delayed on wire",
            "message_id": id1,
            "seq_num": seq_first,
            "retry_count": 0,
            "timestamp": ts1,
        }
        pkt2 = {
            "type": "chat_message",
            "sender": self.username,
            "recipient": clean_recipient,
            "message": f"[Order Test #2 · seq={seq_second}] Sent second, overtook #1",
            "message_id": id2,
            "seq_num": seq_second,
            "retry_count": 0,
            "timestamp": ts2,
        }

        # Transmit pkt2 immediately, delay pkt1
        self._raw_send(pkt2, allow_loss_sim=False)

        def _delayed_first() -> None:
            time.sleep(0.14)
            if self._running:
                try:
                    self._raw_send(pkt1, allow_loss_sim=False)
                except OSError:
                    pass

        threading.Thread(target=_delayed_first, daemon=True).start()
        return [
            {
                "message_id": id1,
                "sender": self.username,
                "recipient": clean_recipient,
                "content": pkt1["message"],
                "timestamp": ts1,
                "status": "sent",
                "retry_count": 0,
                "datagram_bytes": len(json.dumps(pkt1).encode("utf-8")),
                "seq_num": seq_first,
            },
            {
                "message_id": id2,
                "sender": self.username,
                "recipient": clean_recipient,
                "content": pkt2["message"],
                "timestamp": ts2,
                "status": "sent",
                "retry_count": 0,
                "datagram_bytes": len(json.dumps(pkt2).encode("utf-8")),
                "seq_num": seq_second,
            },
        ]

    def send_oversized_test(self, recipient: str) -> None:
        """Attempts to send a datagram larger than 1400 bytes directly to the UDP server to trigger MTU error handling."""
        oversized_text = "UDP-MTU-TEST " * 130  # ~1690 bytes
        packet = {
            "type": "chat_message",
            "sender": self.username,
            "recipient": recipient.strip().lower(),
            "message": oversized_text,
            "message_id": f"mtu-{uuid.uuid4().hex[:8]}",
            "seq_num": 0,
            "timestamp": utc_now_iso(),
        }
        raw = json.dumps(packet, separators=(",", ":")).encode("utf-8")
        self.sock.sendto(raw, self.server_addr)
        with self._lock:
            self.metrics["datagrams_sent"] += 1
        self._record_datagram(
            direction="OUT",
            packet_type="chat_message",
            peer=recipient.strip().lower(),
            byte_len=len(raw),
            message_id=packet["message_id"],
            status="oversized_test",
            note=f"Intentionally exceeded {MAX_DATAGRAM_BYTES} B limit",
        )

    def send_call_signal(
        self,
        signal_type: str,
        recipient: str,
        call_id: str,
        accepted: Optional[bool] = None,
        reason: Optional[str] = None,
    ) -> None:
        packet: Dict[str, Any] = {
            "type": signal_type,
            "sender": self.username,
            "recipient": recipient.strip().lower(),
            "call_id": call_id,
            "timestamp": utc_now_iso(),
        }
        if accepted is not None:
            packet["accepted"] = bool(accepted)
        if reason is not None:
            packet["reason"] = reason
        try:
            self._raw_send(packet, allow_loss_sim=False)
        except OSError:
            pass
        self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})

    def send_voice_frame(
        self,
        recipient: str,
        call_id: str,
        seq: int,
        audio_b64: str,
    ) -> None:
        """
        Streams a compact encoded voice frame directly over UDP (fire-and-forget).
        No ACKs or retransmissions are used so real-time voice demonstrates authentic UDP behavior.
        """
        packet = {
            "type": "voice_frame",
            "sender": self.username,
            "recipient": recipient.strip().lower(),
            "call_id": call_id,
            "seq": int(seq),
            "audio": audio_b64,
        }
        raw = json.dumps(packet, separators=(",", ":")).encode("utf-8")
        if len(raw) > MAX_DATAGRAM_BYTES:
            return

        if self.packet_loss_rate > 0.0 and random.random() < self.packet_loss_rate:
            with self._lock:
                self.metrics["simulated_losses"] += 1
            return

        try:
            self.sock.sendto(raw, self.server_addr)
            with self._lock:
                self.metrics["datagrams_sent"] += 1
                self.metrics["voice_frames_sent"] += 1
                sent_count = self.metrics["voice_frames_sent"]
            if sent_count % 25 == 0:
                self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})
        except OSError:
            pass

    def _send_ack(self, original_sender: str, message_id: str) -> None:
        if not self.ack_enabled:
            return
        ack_packet = {
            "type": "message_ack",
            "sender": self.username,
            "recipient": original_sender,
            "message_id": message_id,
            "timestamp": utc_now_iso(),
        }
        sent_ok, _ = self._raw_send(ack_packet, allow_loss_sim=True)
        if sent_ok:
            with self._lock:
                self.metrics["acks_sent"] += 1

    def _is_duplicate(self, message_id: str) -> bool:
        with self._lock:
            if message_id in self._seen_set:
                self.metrics["duplicates_detected"] += 1
                return True
            if len(self._seen_message_ids) == self._seen_message_ids.maxlen:
                oldest = self._seen_message_ids.popleft()
                self._seen_set.discard(oldest)
            self._seen_message_ids.append(message_id)
            self._seen_set.add(message_id)
            return False

    def _handle_incoming(self, data: bytes, addr: Tuple[str, int]) -> None:
        byte_len = len(data)
        try:
            packet = json.loads(data.decode("utf-8"))
        except Exception:
            return

        if not isinstance(packet, dict):
            return

        ptype = str(packet.get("type", ""))
        sender = str(packet.get("sender", ""))
        msg_id = str(packet.get("message_id", ""))

        with self._lock:
            self.metrics["datagrams_received"] += 1

        if ptype == "presence":
            online = packet.get("online_users") or []
            srv_stats = packet.get("server_stats") or {}
            with self._lock:
                self._online_users = list(online)
                self._server_stats = dict(srv_stats)
            self._emit(
                {
                    "event": "presence",
                    "online_users": online,
                    "peers": packet.get("peers") or [],
                    "server_stats": srv_stats,
                }
            )
            return

        if ptype == "error":
            self._record_datagram(
                direction="IN",
                packet_type="error",
                peer=sender or "udp_server",
                byte_len=byte_len,
                message_id=msg_id,
                status="error",
                note=str(packet.get("message", "")),
            )
            self._emit(
                {
                    "event": "udp_error",
                    "message": packet.get("message", "UDP error"),
                    "message_id": msg_id,
                }
            )
            self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})
            return

        if ptype == "typing":
            self._emit(
                {
                    "event": "typing",
                    "sender": sender,
                    "is_typing": bool(packet.get("is_typing", False)),
                }
            )
            return

        if ptype in ("call_invite", "call_answer", "call_end"):
            call_id = str(packet.get("call_id", ""))
            self._record_datagram(
                direction="IN",
                packet_type=ptype,
                peer=sender,
                byte_len=byte_len,
                message_id=call_id,
                status="received",
                note=f"Voice signal ({ptype})",
            )
            self._emit(
                {
                    "event": ptype,
                    "sender": sender,
                    "call_id": call_id,
                    "accepted": packet.get("accepted"),
                    "reason": packet.get("reason"),
                    "timestamp": packet.get("timestamp", utc_now_iso()),
                }
            )
            self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})
            return

        if ptype == "voice_frame":
            if self.packet_loss_rate > 0.0 and random.random() < (self.packet_loss_rate * 0.5):
                with self._lock:
                    self.metrics["simulated_losses"] += 1
                return
            call_id = str(packet.get("call_id", ""))
            seq = int(packet.get("seq") or 0)
            audio_b64 = str(packet.get("audio", ""))
            with self._lock:
                self.metrics["voice_frames_received"] += 1
                prev_seq = self._last_voice_seq_by_call.get(call_id, 0)
                if seq < prev_seq:
                    self.metrics["voice_out_of_order"] += 1
                else:
                    self._last_voice_seq_by_call[call_id] = seq
                rx_count = self.metrics["voice_frames_received"]

            self._emit(
                {
                    "event": "voice_frame",
                    "sender": sender,
                    "call_id": call_id,
                    "seq": seq,
                    "audio": audio_b64,
                }
            )
            if rx_count % 25 == 0:
                self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})
            return

        if ptype == "message_ack":
            with self._lock:
                self.metrics["acks_received"] += 1
                self._pending_acks.pop(msg_id, None)
            self._record_datagram(
                direction="IN",
                packet_type="message_ack",
                peer=sender,
                byte_len=byte_len,
                message_id=msg_id,
                status="acked",
                note="Application ACK received",
            )
            self._emit(
                {
                    "event": "message_status",
                    "message_id": msg_id,
                    "status": "delivered",
                    "sender": sender,
                }
            )
            self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})
            return

        if ptype == "chat_message":
            if self.packet_loss_rate > 0.0 and random.random() < (self.packet_loss_rate * 0.5):
                with self._lock:
                    self.metrics["simulated_losses"] += 1
                self._record_datagram(
                    direction="IN_LOST",
                    packet_type="chat_message",
                    peer=sender,
                    byte_len=byte_len,
                    message_id=msg_id,
                    status="dropped_sim",
                    note="Simulated inbound UDP packet loss",
                )
                self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})
                return

            is_dup = self._is_duplicate(msg_id)
            seq_num = int(packet.get("seq_num") or 0)
            out_of_order = False
            if not is_dup and seq_num > 0:
                with self._lock:
                    last_seq = self._last_seq_by_sender.get(sender, 0)
                    if seq_num < last_seq:
                        out_of_order = True
                        self.metrics["out_of_order_count"] += 1
                    else:
                        self._last_seq_by_sender[sender] = seq_num

            self._record_datagram(
                direction="IN",
                packet_type="chat_message",
                peer=sender,
                byte_len=byte_len,
                message_id=msg_id,
                status="duplicate_dropped" if is_dup else ("out_of_order" if out_of_order else "received"),
                note=(
                    "Duplicate message_id discarded"
                    if is_dup
                    else (f"Out-of-order seq={seq_num}" if out_of_order else f"seq={seq_num}")
                ),
            )

            # Still send ACK for duplicates so sender stops retrying if its first ACK was lost!
            self._send_ack(sender, msg_id)

            if not is_dup:
                self._emit(
                    {
                        "event": "chat_message",
                        "message": {
                            "message_id": msg_id,
                            "sender": sender,
                            "recipient": self.username,
                            "content": packet.get("message", ""),
                            "timestamp": packet.get("timestamp", utc_now_iso()),
                            "status": "delivered" if self.ack_enabled else "received_no_ack",
                            "retry_count": int(packet.get("retry_count") or 0),
                            "datagram_bytes": byte_len,
                            "seq_num": seq_num,
                            "out_of_order": out_of_order,
                        },
                    }
                )
            self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})

    def _recv_loop(self) -> None:
        while self._running:
            try:
                data, addr = self.sock.recvfrom(65535)
                self._handle_incoming(data, addr)
            except socket.timeout:
                continue
            except OSError:
                break

    def _heartbeat_loop(self) -> None:
        while self._running:
            time.sleep(HEARTBEAT_INTERVAL_SECONDS)
            if not self._running:
                break
            packet = {
                "type": "heartbeat",
                "sender": self.username,
                "recipient": "udp_server",
                "timestamp": utc_now_iso(),
            }
            try:
                self._raw_send(packet)
            except OSError:
                pass

    def _retry_loop(self) -> None:
        while self._running:
            time.sleep(0.5)
            now = time.monotonic()
            to_retry: List[Tuple[str, Dict[str, Any]]] = []
            expired: List[Tuple[str, int]] = []

            with self._lock:
                for msg_id, entry in list(self._pending_acks.items()):
                    if now - entry["last_attempt"] >= self.retry_interval:
                        if entry["attempts"] < entry["max_retries"] and self.retry_enabled:
                            entry["attempts"] += 1
                            entry["last_attempt"] = now
                            pkt = dict(entry["packet"])
                            pkt["retry_count"] = entry["attempts"]
                            to_retry.append((msg_id, pkt))
                        else:
                            expired.append((msg_id, entry["attempts"]))
                            del self._pending_acks[msg_id]

            for msg_id, pkt in to_retry:
                with self._lock:
                    self.metrics["retransmissions"] += 1
                try:
                    self._raw_send(pkt, allow_loss_sim=True)
                except OSError:
                    pass
                if self.db:
                    self.db.update_message_status(
                        msg_id, "retrying", retry_count=int(pkt["retry_count"])
                    )
                self._emit(
                    {
                        "event": "message_status",
                        "message_id": msg_id,
                        "status": "retrying",
                        "retry_count": int(pkt["retry_count"]),
                    }
                )

            for msg_id, attempts in expired:
                with self._lock:
                    self.metrics["missing_acks"] += 1
                if self.db:
                    self.db.update_message_status(
                        msg_id, "unacknowledged", retry_count=attempts
                    )
                self._emit(
                    {
                        "event": "message_status",
                        "message_id": msg_id,
                        "status": "unacknowledged",
                        "retry_count": attempts,
                    }
                )

            if to_retry or expired:
                self._emit({"event": "diagnostics", "diagnostics": self.get_diagnostics()})

    def close(self) -> None:
        if not self._running:
            return
        self._running = False
        disconnect_pkt = {
            "type": "disconnect",
            "sender": self.username,
            "recipient": "udp_server",
            "timestamp": utc_now_iso(),
        }
        try:
            self._raw_send(disconnect_pkt)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone Datagram UDP CLI Client")
    parser.add_argument("--username", required=True, help="Username to register on UDP server")
    parser.add_argument("--peer", required=True, help="Recipient username")
    parser.add_argument(
        "--server-host",
        default=os.environ.get("DATAGRAM_UDP_HOST", "127.0.0.1"),
    )
    parser.add_argument(
        "--server-port",
        type=int,
        default=int(os.environ.get("DATAGRAM_UDP_PORT", "9001")),
    )
    args = parser.parse_args()

    def _on_event(evt: Dict[str, Any]) -> None:
        etype = evt.get("event")
        if etype == "chat_message":
            m = evt["message"]
            print(f"\n[{m['timestamp']}] {m['sender']}: {m['content']}\n> ", end="", flush=True)
        elif etype == "message_status":
            print(
                f"\n[ACK/STATUS] {evt['message_id']} -> {evt['status']}\n> ",
                end="",
                flush=True,
            )

    client = DatagramUDPClient(
        username=args.username,
        server_host=args.server_host,
        server_port=args.server_port,
        on_event=_on_event,
    )
    client.start()
    print(
        f"Connected over UDP (local source port {client.source_port}) -> {args.server_host}:{args.server_port}"
    )
    print(f"Chatting with '{args.peer}'. Type messages and press Enter (Ctrl+C to quit).")
    try:
        while True:
            text = input("> ").strip()
            if text:
                client.send_chat_message(args.peer, text)
    except (KeyboardInterrupt, EOFError):
        print("\nDisconnecting...")
    finally:
        client.close()


if __name__ == "__main__":
    main()
