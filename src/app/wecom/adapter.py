"""企业微信微信客服协议适配：签名校验、AES 解密、回调/消息解析。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import struct
from dataclasses import dataclass
from typing import Any
from xml.etree import ElementTree

from Crypto.Cipher import AES

_BLOCK_SIZE = 32


class WeComSignatureError(ValueError):
    """签名校验失败。"""


class WeComCryptoError(ValueError):
    """企业微信消息解密失败。"""


class WeComPayloadError(ValueError):
    """企业微信消息体格式非法。"""


@dataclass(frozen=True)
class NormalizedEvent:
    """规范化后的企业微信文本消息。"""

    msg_id: str
    from_external_userid: str
    to_staff_userid: str
    msg_type: str
    content: str
    timestamp: int


@dataclass(frozen=True)
class WeComCallbackEvent:
    event: str
    token: str
    raw_payload: dict[str, Any]


class WeComSignatureVerifier:
    """企业微信回调签名校验。"""

    def __init__(self, token: str) -> None:
        self._token = token

    def sign(self, timestamp: str, nonce: str, encrypted_or_echo: str = "") -> str:
        parts = sorted([self._token, timestamp, nonce, encrypted_or_echo])
        raw = "".join(parts).encode("utf-8")
        return hashlib.sha1(raw).hexdigest()  # noqa: S324 - 企业微信官方协议要求 SHA1

    def verify(
        self,
        signature: str,
        timestamp: str,
        nonce: str,
        encrypted_or_echo: str = "",
    ) -> bool:
        expected = self.sign(timestamp, nonce, encrypted_or_echo)
        return hmac.compare_digest(expected, signature)


class WeComCrypto:
    """企业微信官方回调 AES-CBC 解密实现。"""

    def __init__(self, aes_key: str) -> None:
        self._key = _decode_encoding_aes_key(aes_key)
        self._iv = self._key[:16]

    def decrypt(self, encrypted: str, *, receive_id: str) -> str:
        try:
            cipher = AES.new(self._key, AES.MODE_CBC, self._iv)
            plain_padded = cipher.decrypt(_b64decode(encrypted))
        except ValueError as exc:
            raise WeComCryptoError("failed to decrypt wecom payload") from exc
        plain = _pkcs7_unpad(plain_padded)
        if len(plain) < 20:
            raise WeComCryptoError("wecom payload is too short")
        msg_len = struct.unpack(">I", plain[16:20])[0]
        end = 20 + msg_len
        if end > len(plain):
            raise WeComCryptoError("wecom payload length is invalid")
        content = plain[20:end]
        actual_receive_id = plain[end:].decode("utf-8")
        if actual_receive_id != receive_id:
            raise WeComCryptoError("wecom receive id mismatch")
        return content.decode("utf-8")


def parse_encrypted_callback(body: str) -> str:
    payload = _parse_payload_mapping(body)
    encrypted = _get_string(payload, "Encrypt", "encrypt")
    if not encrypted:
        raise WeComPayloadError("encrypted callback body is missing Encrypt field")
    return encrypted


def parse_kf_callback_event(payload: str, *, expected_receive_id: str) -> WeComCallbackEvent:
    data = _parse_payload_mapping(payload)
    receive_id = (
        _get_string(data, "ToUserName", "CorpId", "CorpID", "ReceiveId", "receive_id")
        or expected_receive_id
    )
    if receive_id != expected_receive_id:
        raise WeComPayloadError("wecom callback receive id mismatch")
    event = _get_string(data, "Event", "event")
    token = _get_string(data, "Token", "token")
    if not event or not token:
        raise WeComPayloadError("wecom callback payload is missing event or token")
    return WeComCallbackEvent(event=event, token=token, raw_payload=data)


def parse_kf_sync_message(payload: Any) -> NormalizedEvent | None:
    if not isinstance(payload, dict):
        raise WeComPayloadError("wecom sync_msg item must be an object")
    if str(payload.get("msgtype") or "") != "text":
        return None
    if str(payload.get("origin") or "") != "3":
        return None
    msg_id = _get_string(payload, "msgid")
    external_userid = _get_string(payload, "external_userid", "external_user_id")
    open_kfid = _get_string(payload, "open_kfid")
    text = payload.get("text")
    content = text.get("content") if isinstance(text, dict) else None
    if not msg_id or not external_userid or not open_kfid or not content:
        raise WeComPayloadError("wecom text message is missing required fields")
    timestamp = int(payload.get("send_time") or 0)
    return normalize_text_message(
        msg_id=msg_id,
        from_external_userid=external_userid,
        to_staff_userid=open_kfid,
        content=content,
        timestamp=timestamp,
    )


def normalize_text_message(
    *,
    msg_id: str,
    from_external_userid: str,
    to_staff_userid: str,
    content: str,
    timestamp: int,
) -> NormalizedEvent:
    return NormalizedEvent(
        msg_id=msg_id,
        from_external_userid=from_external_userid,
        to_staff_userid=to_staff_userid,
        msg_type="text",
        content=content,
        timestamp=timestamp,
    )


def _parse_payload_mapping(payload: str) -> dict[str, Any]:
    stripped = payload.strip()
    if not stripped:
        raise WeComPayloadError("wecom payload is empty")
    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise WeComPayloadError("wecom json payload is invalid") from exc
        if not isinstance(data, dict):
            raise WeComPayloadError("wecom json payload must be an object")
        return data
    if not stripped.startswith("<"):
        raise WeComPayloadError("unsupported wecom payload format")
    try:
        root = ElementTree.fromstring(stripped)
    except ElementTree.ParseError as exc:
        raise WeComPayloadError("wecom xml payload is invalid") from exc
    result: dict[str, Any] = {}
    for child in root:
        if list(child):
            result[child.tag] = {
                nested.tag: nested.text or "" for nested in child if nested.tag is not None
            }
        else:
            result[child.tag] = child.text or ""
    return result


def _decode_encoding_aes_key(aes_key: str) -> bytes:
    if not aes_key:
        raise WeComCryptoError("EncodingAESKey is required")
    key = _b64decode(aes_key)
    if len(key) != 32:
        raise WeComCryptoError("EncodingAESKey must decode to 32 bytes")
    return key


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.b64decode(value + padding)


def _pkcs7_unpad(payload: bytes) -> bytes:
    if not payload:
        raise WeComCryptoError("wecom payload is empty after decrypt")
    pad = payload[-1]
    if pad < 1 or pad > _BLOCK_SIZE:
        raise WeComCryptoError("invalid wecom pkcs7 padding")
    if payload[-pad:] != bytes([pad]) * pad:
        raise WeComCryptoError("invalid wecom pkcs7 padding")
    return payload[:-pad]


def _get_string(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return ""
