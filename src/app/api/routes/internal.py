"""Bridge 专用内部路由。"""

from __future__ import annotations

import secrets
import uuid

from fastapi import APIRouter, Depends, Request, status

from app.api.deps import get_container, get_uow
from app.core.container import Container
from app.core.errors import AppError
from app.db.repository import UnitOfWork
from app.schemas.internal_chat import BridgeChatRequest, BridgeChatResponse

router = APIRouter(prefix='/internal', tags=['internal'])


def _extract_bearer_token(value: str | None) -> str | None:
    if value is None:
        return None
    scheme, _, token = value.partition(' ')
    if scheme.lower() != 'bearer' or not token.strip():
        return None
    return token.strip()


def _authorize_bridge(request: Request, container: Container) -> None:
    expected = container.settings.ai_bridge_token
    if not expected:
        raise AppError(
            'bridge_auth_not_configured',
            'AI_BRIDGE_TOKEN is not configured',
            status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    provided = _extract_bearer_token(request.headers.get('Authorization'))
    if provided is None:
        raise AppError(
            'unauthorized',
            'missing bearer token',
            status.HTTP_401_UNAUTHORIZED,
        )
    if not secrets.compare_digest(provided, expected):
        raise AppError(
            'forbidden',
            'invalid bridge token',
            status.HTTP_403_FORBIDDEN,
        )


@router.post('/chat', response_model=BridgeChatResponse)
async def internal_chat(
    payload: BridgeChatRequest,
    request: Request,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> BridgeChatResponse:
    _authorize_bridge(request, container)
    correlation_id = request.headers.get('X-Correlation-Id') or str(uuid.uuid4())
    result = await container.bridge_chat_service.handle_message(
        uow,
        conversation_key=payload.conversation_key,
        contact_id=payload.contact_id,
        staff_userid=payload.staff_userid,
        message_id=payload.message_id,
        text=payload.text,
        correlation_id=correlation_id,
    )
    await uow.commit()
    return BridgeChatResponse(
        conversation_id=result.conversation_id,
        message_id=result.message_id,
        reply=result.reply,
        correlation_id=result.correlation_id,
    )
