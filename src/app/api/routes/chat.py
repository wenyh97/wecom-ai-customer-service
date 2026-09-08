"""/chat/messages 路由：客户会话消息入口 + AI 回复。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request

from app.api.deps import get_container, get_uow
from app.core.container import Container
from app.db.repository import UnitOfWork
from app.schemas.chat import ChatMessageRequest, ChatMessageResponse, Citation

router = APIRouter(prefix='/chat', tags=['chat'])


@router.post('/messages', response_model=ChatMessageResponse)
async def send_message(
    payload: ChatMessageRequest,
    request: Request,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> ChatMessageResponse:
    correlation_id = request.headers.get('X-Correlation-Id') or str(uuid.uuid4())

    idempotency_key = payload.idempotency_key
    if idempotency_key:
        cached = await container.idempotency_store.get(uow, idempotency_key)
        if cached is not None:
            return ChatMessageResponse(**cached)

    conversation = await container.conversation_store.get_or_create(
        uow,
        payload.customer_external_userid,
        payload.staff_userid,
        conversation_id=payload.conversation_id,
    )
    await container.conversation_store.append_message(
        uow,
        conversation_id=conversation.conversation_id,
        role='customer',
        content=payload.content,
        message_type=payload.message_type,
    )

    handoff_record = await container.handoffs.get(uow, conversation.conversation_id)
    if handoff_record.active:
        await container.audit_log.record(
            uow,
            conversation_id=conversation.conversation_id,
            handoff_required=True,
            confidence=0.0,
            citations=[],
            raw_input=payload.content,
            correlation_id=correlation_id,
            payload={'reason': 'handoff_active'},
            event_type='chat_message',
        )
        result_payload = ChatMessageResponse(
            conversation_id=conversation.conversation_id,
            reply=None,
            handoff_required=True,
            confidence=0.0,
            citations=[],
            correlation_id=correlation_id,
        )
    else:
        history = await container.conversation_store.list_recent_messages(
            uow, conversation.conversation_id, limit=10
        )
        result = await container.ai_orchestrator.handle_message(
            payload.content,
            history=[f'{message.role}:{message.content}' for message in history],
        )
        if result.handoff_required:
            await container.handoffs.takeover(
                uow,
                conversation.conversation_id,
                operator='system',
                reason='low_confidence_or_sensitive',
            )
        elif result.reply:
            await container.conversation_store.append_message(
                uow,
                conversation_id=conversation.conversation_id,
                role='assistant',
                content=result.reply,
                is_ai_generated=True,
            )
            await container.outbound_dispatcher.send_text(conversation.conversation_id, result.reply)

        await container.audit_log.record(
            uow,
            conversation_id=conversation.conversation_id,
            handoff_required=result.handoff_required,
            confidence=result.confidence,
            citations=[c.source_id for c in result.citations],
            raw_input=payload.content,
            correlation_id=correlation_id,
            payload={
                'reply_present': result.reply is not None,
                'message_type': payload.message_type,
            },
            event_type='chat_message',
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
        await container.idempotency_store.set(uow, idempotency_key, result_payload.model_dump())

    await uow.commit()
    return result_payload
