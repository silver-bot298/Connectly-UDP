"""
Authentication utilities for Datagram.
Uses salted scrypt password hashing and HMAC-SHA256 signed session tokens.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from typing import Any, Dict, Optional

USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]{3,24}$")

_ENV_SECRET = os.environ.get("DATAGRAM_AUTH_SECRET", "").strip()
_TOKEN_SECRET: bytes = (
    _ENV_SECRET.encode("utf-8") if _ENV_SECRET else secrets.token_bytes(32)
)
TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7  # 7 days


def validate_username(username: str) -> str:
    cleaned = username.strip().lower()
    if not USERNAME_PATTERN.match(cleaned):
        raise ValueError(
            "Username must be 3–24 characters using letters, numbers, '.', '_', or '-'."
        )
    return cleaned


def validate_password(password: str) -> str:
    if not isinstance(password, str) or len(password) < 6:
        raise ValueError("Password must be at least 6 characters long.")
    if len(password) > 128:
        raise ValueError("Password must be 128 characters or fewer.")
    return password


def validate_full_name(full_name: str) -> str:
    cleaned = " ".join(full_name.strip().split())
    if len(cleaned) < 2 or len(cleaned) > 60:
        raise ValueError("Full name must be between 2 and 60 characters.")
    return cleaned


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=16384,
        r=8,
        p=1,
        dklen=32,
    )
    return f"scrypt${salt.hex()}${derived.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, salt_hex, hash_hex = stored_hash.split("$", 2)
        if scheme != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=16384,
            r=8,
            p=1,
            dklen=32,
        )
        return hmac.compare_digest(derived, expected)
    except Exception:
        return False


def create_session_token(username: str) -> str:
    payload = {
        "sub": username,
        "iat": int(time.time()),
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    payload_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).rstrip(b"=").decode("ascii")
    sig = hmac.new(_TOKEN_SECRET, payload_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return f"{payload_b64}.{sig_b64}"


def verify_session_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        if not token or "." not in token:
            return None
        payload_b64, sig_b64 = token.split(".", 1)
        expected_sig = hmac.new(
            _TOKEN_SECRET, payload_b64.encode("ascii"), hashlib.sha256
        ).digest()
        expected_sig_b64 = (
            base64.urlsafe_b64encode(expected_sig).rstrip(b"=").decode("ascii")
        )
        if not hmac.compare_digest(sig_b64, expected_sig_b64):
            return None

        padding = "=" * (-len(payload_b64) % 4)
        payload = json.loads(
            base64.urlsafe_b64decode(payload_b64 + padding).decode("utf-8")
        )
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except Exception:
        return None
