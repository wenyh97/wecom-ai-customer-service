"""企业微信微信客服回调路由。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, Response

from app.api.deps import get_container
from app.core.container import Container
from app.core.errors import AppError
from app.wecom.adapter import (
    WeComCrypto,
    WeComCryptoError,
    WeComPayloadError,
    WeComSignatureVerifier,
    parse_encrypted_callback,
    parse_kf_callback_event,
)

router = APIRouter(prefix="/wecom", tags=["wecom"])


def _build_crypto(container: Container) -> WeComCrypto:
    receive_id = container.settings.wecom_effective_receive_id
    if not container.settings.wecom_token or not container.settings.wecom_encoding_aes_key or not receive_id:
        raise AppError(
            "wecom_not_configured",
            "wecom kf callback token, EncodingAESKey or receive id is not configured",
            503,
        )
    return WeComCrypto(aes_key=container.settings.wecom_encoding_aes_key)


@router.get("/callback")
@router.get("/kf/callback")
async def verify_callback(
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    echostr: str = Query(...),
    container: Container = Depends(get_container),
) -> Response:
    verifier = WeComSignatureVerifier(token=container.settings.wecom_token)
    if not verifier.verify(msg_signature, timestamp, nonce, echostr):
        raise AppError("invalid_signature", "signature verification failed", 403)

    try:
        crypto = _build_crypto(container)
        decrypted = crypto.decrypt(
            echostr,
            receive_id=container.settings.wecom_effective_receive_id,
        )
    except WeComCryptoError as exc:
        raise AppError("invalid_wecom_payload", str(exc), 400) from exc
    return Response(content=decrypted, media_type="text/plain")


@router.post("/callback")
@router.post("/kf/callback")
async def receive_callback(
    request: Request,
    background_tasks: BackgroundTasks,
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    container: Container = Depends(get_container),
) -> Response:
    body = (await request.body()).decode("utf-8")
    try:
        encrypted = parse_encrypted_callback(body)
    except WeComPayloadError as exc:
        raise AppError("invalid_wecom_payload", str(exc), 400) from exc

    verifier = WeComSignatureVerifier(token=container.settings.wecom_token)
    if not verifier.verify(msg_signature, timestamp, nonce, encrypted):
        raise AppError("invalid_signature", "signature verification failed", 403)

    try:
        crypto = _build_crypto(container)
        decrypted = crypto.decrypt(
            encrypted,
            receive_id=container.settings.wecom_effective_receive_id,
        )
        event = parse_kf_callback_event(
            decrypted,
            expected_receive_id=container.settings.wecom_effective_receive_id,
        )
    except (WeComCryptoError, WeComPayloadError) as exc:
        raise AppError("invalid_wecom_payload", str(exc), 400) from exc

    correlation_id = request.headers.get("X-Correlation-Id") or str(uuid.uuid4())
    background_tasks.add_task(
        container.wecom_kf_service.handle_callback_event,
        event,
        correlation_id,
    )
    return Response(content="success", media_type="text/plain")
