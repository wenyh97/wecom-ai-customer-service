from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.core.container import Container
from app.wecom.adapter import WeComSignatureVerifier
from tests.helpers_wecom import encrypt_wecom_message


def test_wecom_callback_verification_success(client: TestClient, container: Container) -> None:
    verifier = WeComSignatureVerifier(token="test-token")
    timestamp = "1700000000"
    nonce = "nonce123"
    encrypted_echo = encrypt_wecom_message(
        plaintext="echo-value",
        aes_key=container.settings.wecom_encoding_aes_key,
        receive_id=container.settings.wecom_effective_receive_id,
    )
    signature = verifier.sign(timestamp, nonce, encrypted_echo)

    resp = client.get(
        "/wecom/kf/callback",
        params={
            "msg_signature": signature,
            "timestamp": timestamp,
            "nonce": nonce,
            "echostr": encrypted_echo,
        },
    )
    assert resp.status_code == 200
    assert resp.text == "echo-value"


def test_wecom_callback_verification_rejects_invalid_signature(client: TestClient) -> None:
    resp = client.get(
        "/wecom/kf/callback",
        params={
            "msg_signature": "invalid",
            "timestamp": "1700000000",
            "nonce": "nonce123",
            "echostr": "echo-value",
        },
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "invalid_signature"


def test_wecom_callback_post_accepts_encrypted_event(
    client: TestClient,
    container: Container,
    monkeypatch,
) -> None:
    captured: dict[str, str] = {}

    async def fake_handle_callback_event(event, correlation_id: str) -> None:
        captured["event"] = event.event
        captured["token"] = event.token
        captured["correlation_id"] = correlation_id

    monkeypatch.setattr(
        container.wecom_kf_service,
        "handle_callback_event",
        fake_handle_callback_event,
    )
    verifier = WeComSignatureVerifier(token="test-token")
    timestamp = "1700000000"
    nonce = "nonce123"
    encrypted = encrypt_wecom_message(
        plaintext=json.dumps(
            {
                "ToUserName": container.settings.wecom_effective_receive_id,
                "Event": "kf_msg_or_event",
                "Token": "sync-token-1",
            }
        ),
        aes_key=container.settings.wecom_encoding_aes_key,
        receive_id=container.settings.wecom_effective_receive_id,
    )
    signature = verifier.sign(timestamp, nonce, encrypted)

    resp = client.post(
        "/wecom/kf/callback",
        params={
            "msg_signature": signature,
            "timestamp": timestamp,
            "nonce": nonce,
        },
        json={"encrypt": encrypted},
    )
    assert resp.status_code == 200
    assert resp.text == "success"
    assert captured["event"] == "kf_msg_or_event"
    assert captured["token"] == "sync-token-1"
    assert captured["correlation_id"]
