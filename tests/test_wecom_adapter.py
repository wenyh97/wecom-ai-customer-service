from __future__ import annotations

import json

import pytest

from app.wecom.adapter import (
    WeComCrypto,
    WeComCryptoError,
    WeComSignatureVerifier,
    parse_kf_callback_event,
    parse_kf_sync_message,
)
from tests.helpers_wecom import encrypt_wecom_message

_AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
_RECEIVE_ID = "ww-test-corp"


def test_signature_verifier_accepts_valid_signature() -> None:
    verifier = WeComSignatureVerifier(token="test-token")
    timestamp = "1700000000"
    nonce = "abc123"
    echostr = "hello-world"
    signature = verifier.sign(timestamp, nonce, echostr)
    assert verifier.verify(signature, timestamp, nonce, echostr) is True


def test_signature_verifier_rejects_tampered_signature() -> None:
    verifier = WeComSignatureVerifier(token="test-token")
    timestamp = "1700000000"
    nonce = "abc123"
    echostr = "hello-world"
    signature = verifier.sign(timestamp, nonce, echostr)
    assert verifier.verify(signature, timestamp, nonce, "tampered") is False


def test_crypto_decrypts_and_validates_receive_id() -> None:
    crypto = WeComCrypto(aes_key=_AES_KEY)
    encrypted = encrypt_wecom_message(
        plaintext="echo-value",
        aes_key=_AES_KEY,
        receive_id=_RECEIVE_ID,
    )
    assert crypto.decrypt(encrypted, receive_id=_RECEIVE_ID) == "echo-value"


def test_crypto_rejects_wrong_receive_id() -> None:
    crypto = WeComCrypto(aes_key=_AES_KEY)
    encrypted = encrypt_wecom_message(
        plaintext="echo-value",
        aes_key=_AES_KEY,
        receive_id=_RECEIVE_ID,
    )
    with pytest.raises(WeComCryptoError):
        crypto.decrypt(encrypted, receive_id="ww-other")


def test_parse_callback_event_from_json_payload() -> None:
    event = parse_kf_callback_event(
        json.dumps(
            {
                "ToUserName": _RECEIVE_ID,
                "Event": "kf_msg_or_event",
                "Token": "event-token-1",
            }
        ),
        expected_receive_id=_RECEIVE_ID,
    )
    assert event.event == "kf_msg_or_event"
    assert event.token == "event-token-1"


def test_parse_kf_sync_message_filters_non_customer_or_non_text() -> None:
    assert parse_kf_sync_message({"msgtype": "image", "origin": 3}) is None
    assert parse_kf_sync_message({"msgtype": "text", "origin": 4}) is None


def test_parse_kf_sync_message_normalizes_customer_text() -> None:
    event = parse_kf_sync_message(
        {
            "msgid": "msg-1",
            "open_kfid": "kf-1",
            "external_userid": "external-1",
            "send_time": 1700000001,
            "origin": 3,
            "msgtype": "text",
            "text": {"content": "你好"},
        }
    )
    assert event is not None
    assert event.msg_id == "msg-1"
    assert event.to_staff_userid == "kf-1"
    assert event.from_external_userid == "external-1"
    assert event.content == "你好"
