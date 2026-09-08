from __future__ import annotations

from app.wecom.adapter import WeComCrypto, WeComSignatureVerifier


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


def test_signature_verifier_rejects_wrong_token() -> None:
    verifier_a = WeComSignatureVerifier(token="token-a")
    verifier_b = WeComSignatureVerifier(token="token-b")
    timestamp = "1700000000"
    nonce = "abc123"
    signature = verifier_a.sign(timestamp, nonce)
    assert verifier_b.verify(signature, timestamp, nonce) is False


def test_crypto_passthrough_without_aes_key() -> None:
    crypto = WeComCrypto(aes_key="")
    assert crypto.decrypt("plain-payload") == "plain-payload"


def test_crypto_raises_not_implemented_with_aes_key() -> None:
    crypto = WeComCrypto(aes_key="some-configured-key")
    try:
        crypto.decrypt("encrypted-payload")
    except NotImplementedError:
        pass
    else:  # pragma: no cover - defensive
        raise AssertionError("expected NotImplementedError")
