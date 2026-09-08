from __future__ import annotations

from fastapi.testclient import TestClient

from app.wecom.adapter import WeComSignatureVerifier


def test_wecom_callback_verification_success(client: TestClient) -> None:
    verifier = WeComSignatureVerifier(token="test-token")
    timestamp = "1700000000"
    nonce = "nonce123"
    echostr = "echo-value"
    signature = verifier.sign(timestamp, nonce, echostr)

    resp = client.get(
        "/wecom/callback",
        params={
            "msg_signature": signature,
            "timestamp": timestamp,
            "nonce": nonce,
            "echostr": echostr,
        },
    )
    assert resp.status_code == 200
    assert resp.text == echostr


def test_wecom_callback_verification_rejects_invalid_signature(
    client: TestClient,
) -> None:
    resp = client.get(
        "/wecom/callback",
        params={
            "msg_signature": "invalid",
            "timestamp": "1700000000",
            "nonce": "nonce123",
            "echostr": "echo-value",
        },
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "invalid_signature"


def test_wecom_callback_post_accepts_event(client: TestClient) -> None:
    resp = client.post(
        "/wecom/callback",
        params={
            "msg_signature": "any",
            "timestamp": "1700000000",
            "nonce": "nonce123",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "accepted"
