"""
SQLite persistence layer for Datagram.
Stores user accounts (salted scrypt password hashes), chat message history,
delivery statuses, and UDP datagram diagnostic logs.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_DB_PATH = str(Path(__file__).resolve().parent / "datagram.db")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class DatagramDatabase:
    def __init__(self, db_path: Optional[str] = None) -> None:
        self.db_path = db_path or os.environ.get("DATAGRAM_DB_PATH", DEFAULT_DB_PATH)
        self._lock = threading.RLock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_schema(self) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS users (
                        username TEXT PRIMARY KEY,
                        full_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        avatar_url TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS messages (
                        message_id TEXT PRIMARY KEY,
                        sender TEXT NOT NULL,
                        recipient TEXT NOT NULL,
                        content TEXT NOT NULL,
                        timestamp TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'sent',
                        retry_count INTEGER NOT NULL DEFAULT 0,
                        datagram_bytes INTEGER NOT NULL DEFAULT 0,
                        seq_num INTEGER NOT NULL DEFAULT 0
                    );

                    CREATE INDEX IF NOT EXISTS idx_messages_pair
                        ON messages (sender, recipient, timestamp);

                    CREATE TABLE IF NOT EXISTS datagram_logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        direction TEXT NOT NULL,
                        packet_type TEXT NOT NULL,
                        sender TEXT,
                        recipient TEXT,
                        src_addr TEXT,
                        dst_addr TEXT,
                        message_id TEXT,
                        payload_bytes INTEGER NOT NULL DEFAULT 0,
                        note TEXT,
                        created_at TEXT NOT NULL
                    );

                    CREATE INDEX IF NOT EXISTS idx_logs_created
                        ON datagram_logs (id DESC);
                    """
                )
                conn.commit()
            finally:
                conn.close()

    # ── Users ──────────────────────────────────────────────────────────────

    def create_user(
        self,
        username: str,
        full_name: str,
        password_hash: str,
        avatar_url: str,
    ) -> Dict[str, Any]:
        created_at = utc_now_iso()
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO users (username, full_name, password_hash, avatar_url, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (username, full_name, password_hash, avatar_url, created_at),
                )
                conn.commit()
            finally:
                conn.close()
        return {
            "username": username,
            "full_name": full_name,
            "avatar_url": avatar_url,
            "created_at": created_at,
        }

    def get_user_with_hash(self, username: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT username, full_name, password_hash, avatar_url, created_at FROM users WHERE username = ?",
                    (username,),
                ).fetchone()
                return dict(row) if row else None
            finally:
                conn.close()

    def get_user(self, username: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                row = conn.execute(
                    "SELECT username, full_name, avatar_url, created_at FROM users WHERE username = ?",
                    (username,),
                ).fetchone()
                return dict(row) if row else None
            finally:
                conn.close()

    def update_user_profile(
        self, username: str, full_name: str, avatar_url: str
    ) -> Optional[Dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    "UPDATE users SET full_name = ?, avatar_url = ? WHERE username = ?",
                    (full_name, avatar_url, username),
                )
                conn.commit()
            finally:
                conn.close()
        return self.get_user(username)

    def list_users(self) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    "SELECT username, full_name, avatar_url, created_at FROM users ORDER BY full_name ASC"
                ).fetchall()
                return [dict(r) for r in rows]
            finally:
                conn.close()

    # ── Messages ───────────────────────────────────────────────────────────

    def save_message(
        self,
        message_id: str,
        sender: str,
        recipient: str,
        content: str,
        timestamp: str,
        status: str = "sent",
        retry_count: int = 0,
        datagram_bytes: int = 0,
        seq_num: int = 0,
    ) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO messages (
                        message_id, sender, recipient, content, timestamp,
                        status, retry_count, datagram_bytes, seq_num
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(message_id) DO UPDATE SET
                        retry_count = MAX(messages.retry_count, excluded.retry_count),
                        datagram_bytes = MAX(messages.datagram_bytes, excluded.datagram_bytes)
                    """,
                    (
                        message_id,
                        sender,
                        recipient,
                        content,
                        timestamp,
                        status,
                        retry_count,
                        datagram_bytes,
                        seq_num,
                    ),
                )
                conn.commit()
            finally:
                conn.close()

    def update_message_status(
        self, message_id: str, status: str, retry_count: Optional[int] = None
    ) -> None:
        with self._lock:
            conn = self._connect()
            try:
                if retry_count is not None:
                    conn.execute(
                        "UPDATE messages SET status = ?, retry_count = ? WHERE message_id = ?",
                        (status, retry_count, message_id),
                    )
                else:
                    conn.execute(
                        "UPDATE messages SET status = ? WHERE message_id = ?",
                        (status, message_id),
                    )
                conn.commit()
            finally:
                conn.close()

    def get_conversation(
        self, user_a: str, user_b: str, limit: int = 150
    ) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT message_id, sender, recipient, content, timestamp,
                           status, retry_count, datagram_bytes, seq_num
                    FROM messages
                    WHERE (sender = ? AND recipient = ?)
                       OR (sender = ? AND recipient = ?)
                    ORDER BY timestamp ASC, rowid ASC
                    LIMIT ?
                    """,
                    (user_a, user_b, user_b, user_a, limit),
                ).fetchall()
                return [dict(r) for r in rows]
            finally:
                conn.close()

    def get_recent_conversations_for(self, username: str) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT message_id, sender, recipient, content, timestamp, status
                    FROM messages
                    WHERE sender = ? OR recipient = ?
                    ORDER BY timestamp DESC, rowid DESC
                    """,
                    (username, username),
                ).fetchall()
                seen: Dict[str, Dict[str, Any]] = {}
                for r in rows:
                    peer = r["recipient"] if r["sender"] == username else r["sender"]
                    if peer not in seen:
                        seen[peer] = {
                            "peer": peer,
                            "last_message": r["content"],
                            "last_timestamp": r["timestamp"],
                            "last_sender": r["sender"],
                            "last_status": r["status"],
                        }
                return list(seen.values())
            finally:
                conn.close()

    # ── Datagram Logs ──────────────────────────────────────────────────────

    def log_datagram(
        self,
        direction: str,
        packet_type: str,
        sender: Optional[str],
        recipient: Optional[str],
        src_addr: Optional[str],
        dst_addr: Optional[str],
        message_id: Optional[str],
        payload_bytes: int,
        note: str = "",
    ) -> None:
        created_at = utc_now_iso()
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO datagram_logs (
                        direction, packet_type, sender, recipient,
                        src_addr, dst_addr, message_id, payload_bytes, note, created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        direction,
                        packet_type,
                        sender,
                        recipient,
                        src_addr,
                        dst_addr,
                        message_id,
                        payload_bytes,
                        note,
                        created_at,
                    ),
                )
                # Keep table bounded to last 1000 rows
                conn.execute(
                    """
                    DELETE FROM datagram_logs
                    WHERE id NOT IN (
                        SELECT id FROM datagram_logs ORDER BY id DESC LIMIT 1000
                    )
                    """
                )
                conn.commit()
            finally:
                conn.close()

    def get_recent_logs(self, limit: int = 100) -> List[Dict[str, Any]]:
        with self._lock:
            conn = self._connect()
            try:
                rows = conn.execute(
                    """
                    SELECT id, direction, packet_type, sender, recipient,
                           src_addr, dst_addr, message_id, payload_bytes, note, created_at
                    FROM datagram_logs
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                return [dict(r) for r in rows]
            finally:
                conn.close()
