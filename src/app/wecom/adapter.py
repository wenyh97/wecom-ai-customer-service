"""企业微信适配器：签名校验、加解密占位、消息规范化。

重要声明：本模块仅提供**可测试的占位实现**，用于本阶段骨架的开发与测试，
不代表已经过企业微信官方联调验证的生产行为。真实对接前必须对照企业微信
最新官方文档逐项确认加解密算法、Token 有效期、消息体格式等细节
（见 specs/spec.md §6 `TODO(confirm-with-wecom-docs)`）。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass


class WeComSignatureError(ValueError):
    """签名校验失败。"""


@dataclass(frozen=True)
class NormalizedEvent:
    """规范化后的企业微信消息事件，供上层会话服务消费。"""

    msg_id: str
    from_external_userid: str
    to_staff_userid: str
    msg_type: str
    content: str
    timestamp: int


class WeComSignatureVerifier:
    """企业微信回调签名校验。

    算法参照企业微信公开文档的通用签名规则：对 `token`、`timestamp`、`nonce`
    （以及加密消息回调场景下的密文）排序后拼接做 SHA1，与 `msg_signature` 比较。
    **加密消息场景的具体输入组合请在真实对接前对照官方文档确认**
    （TODO(confirm-with-wecom-docs)）。
    """

    def __init__(self, token: str) -> None:
        self._token = token

    def sign(self, timestamp: str, nonce: str, encrypted_or_echo: str = "") -> str:
        parts = sorted([self._token, timestamp, nonce, encrypted_or_echo])
        raw = "".join(parts).encode("utf-8")
        return hashlib.sha1(raw).hexdigest()  # noqa: S324 - 企业微信官方要求使用 SHA1

    def verify(
        self,
        signature: str,
        timestamp: str,
        nonce: str,
        encrypted_or_echo: str = "",
    ) -> bool:
        expected = self.sign(timestamp, nonce, encrypted_or_echo)
        return _constant_time_equals(expected, signature)


def _constant_time_equals(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a, b, strict=False):
        result |= ord(x) ^ ord(y)
    return result == 0


class WeComCrypto:
    """企业微信消息加解密占位实现。

    第一阶段不实现真实的 AES-CBC 解密（企业微信官方算法涉及 16 字节随机数、
    网络字节序长度、CorpID 校验等细节，需在真实对接前对照官方 SDK/文档确认，
    见 TODO(confirm-with-wecom-docs)）。当前实现仅做透传，便于本地开发和测试
    在未配置真实 AES Key 时也能跑通整体流程；生产环境启用前必须替换为
    经过官方文档验证的真实实现。
    """

    def __init__(self, aes_key: str = "") -> None:
        self._aes_key = aes_key

    def decrypt(self, raw_payload: str) -> str:
        if not self._aes_key:
            # 未配置密钥：视为明文透传（仅用于本地开发/测试）
            return raw_payload
        raise NotImplementedError(
            "真实 AES 解密尚未实现，需对照企业微信官方文档确认算法细节 "
            "(TODO(confirm-with-wecom-docs))"
        )


def normalize_text_message(
    *,
    msg_id: str,
    from_external_userid: str,
    to_staff_userid: str,
    content: str,
    timestamp: int,
) -> NormalizedEvent:
    """将解密后的文本消息字段规范化为内部事件结构。"""

    return NormalizedEvent(
        msg_id=msg_id,
        from_external_userid=from_external_userid,
        to_staff_userid=to_staff_userid,
        msg_type="text",
        content=content,
        timestamp=timestamp,
    )
