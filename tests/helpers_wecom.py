from __future__ import annotations

import base64
import struct

from Crypto.Cipher import AES


def encrypt_wecom_message(*, plaintext: str, aes_key: str, receive_id: str) -> str:
    key = base64.b64decode(aes_key + "=")
    iv = key[:16]
    payload = (
        b"0123456789ABCDEF"
        + struct.pack(">I", len(plaintext.encode("utf-8")))
        + plaintext.encode("utf-8")
        + receive_id.encode("utf-8")
    )
    pad = 32 - len(payload) % 32
    payload += bytes([pad]) * pad
    encrypted = AES.new(key, AES.MODE_CBC, iv).encrypt(payload)
    return base64.b64encode(encrypted).decode("utf-8")
