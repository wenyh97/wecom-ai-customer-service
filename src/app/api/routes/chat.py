"""/chat/messages 路由：客户会话消息入口 + AI 回复。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request

from app.api.deps import get_container
from app.core.container import Container
from app.schemas.chat import ChatMessageRequest, ChatMessageResponse, Citation
from app.services.conversation import Message

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("/messages", response_model=ChatMessageResponse)
async def send_message(
    payload: ChatMessageRequest,
    request: Request,
    container: Container = Depends(get_container),
) -> ChatMessageResponse:
    correlation_id = request.headers.get("X-Correlation-Id") or str(uuid.uuid4())

    idempotency_key = payload.idempotency_key
    if idempotency_key:
        cached = await container.idempotency_store.get(idempotency_key)
        if cached is not None:
            return ChatMessageResponse(**cached)

    conversation = container.conversation_store.get_or_create(
        payload.customer_external_userid, payload.staff_userid
    )
    conversation.messages.append(Message(role="customer", content=payload.content))

    handoff_record = container.handoffs.get(conversation.conversation_id)
    if handoff_record.active:
        result_payload = ChatMessageResponse(
            conversation_id=conversation.conversation_id,
            reply=None,
            handoff_required=True,
            confidence=0.0,
            citations=[],
            correlation_id=correlation_id,
        )
    else:
        result = await container.ai_orchestrator.handle_message(payload.content)
        if result.handoff_required:
            container.handoffs.takeover(
                conversation.conversation_id,
                operator="system",
                reason="low_confidence_or_sensitive",
            )
        elif result.reply:
            conversation.messages.append(Message(role="assistant", content=result.reply))

        container.audit_log.record(
            conversation_id=conversation.conversation_id,
            handoff_required=result.handoff_required,
            confidence=result.confidence,
            citations=[c.source_id for c in result.citations],
            raw_input=payload.content,
            correlation_id=correlation_id,
        )

        result_payload = ChatMessageResponse(
            conversation_id=conversation.conversation_id,
            reply=result.reply,
            handoff_required=result.handoff_required,
            confidence=result.confidence,
            citations=[
                Citation(source_id=c.source_id, title=c.title, score=c.score)
                for c in result.citations
            ],
            correlation_id=correlation_id,
        )

    if idempotency_key:
        await container.idempotency_store.set(idempotency_key, result_payload.model_dump())

    return result_payload
