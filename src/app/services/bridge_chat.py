"""Wechaty / WorkPro Bridge 对话服务。"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings
from app.core.errors import AppError, ConflictError, UpstreamTimeoutError
from app.core.logging import get_logger
from app.db.repository import UnitOfWork
from app.llm.provider import ChatMessage, LLMCallError, LLMProvider, LLMTimeoutError
from app.services.audit import AuditLogStore
from app.services.conversation import ConversationStore, Message
from app.services.idempotency import IdempotencyStore

_SYSTEM_PROMPT = (
    '你是某公司的中文智能客服演示助手。'
    '请基于当前用户问题和最近对话上下文，给出简洁、友好、专业的中文回复。'
    '不要编造价格、承诺、政策或内部信息；不确定时请坦诚说明，并建议联系人工客服。'
)


@dataclass(frozen=True)
class BridgeChatResult:
    conversation_id: str
    message_id: str
    reply: str
    correlation_id: str

    def to_payload(self) -> dict[str, str]:
        return {
            'conversation_id': self.conversation_id,
            'message_id': self.message_id,
            'reply': self.reply,
            'correlation_id': self.correlation_id,
        }


class BridgeChatService:
    def __init__(
        self,
        *,
        settings: Settings,
        llm_provider: LLMProvider,
        conversation_store: ConversationStore,
        idempotency_store: IdempotencyStore,
        audit_log: AuditLogStore,
    ) -> None:
        self._settings = settings
        self._llm_provider = llm_provider
        self._conversation_store = conversation_store
        self._idempotency_store = idempotency_store
        self._audit_log = audit_log
        self._logger = get_logger(component='bridge_chat')

    async def handle_message(
        self,
        uow: UnitOfWork,
        *,
        conversation_key: str,
        contact_id: str,
        staff_userid: str,
        message_id: str,
        text: str,
        correlation_id: str,
    ) -> BridgeChatResult:
        message_text = text.strip()
        if not message_text:
            raise AppError('empty_message', 'message text is empty', 400)
        if not self._settings.llm_api_key:
            raise AppError(
                'llm_not_configured',
                'LLM_API_KEY is not configured for bridge chat',
                503,
            )

        tenant = await uow.tenants.get_or_create(
            self._settings.default_tenant_slug,
            self._settings.default_tenant_name,
        )
        idempotency_key = f'bridge:wechaty-workpro:{message_id}'
        cached = await self._idempotency_store.get(uow, idempotency_key)
        if cached is not None:
            return BridgeChatResult(**cached)
        if not await uow.idempotency.reserve(tenant_id=tenant.id, key=idempotency_key):
            cached = await self._idempotency_store.get(uow, idempotency_key)
            if cached is not None:
                return BridgeChatResult(**cached)
            raise ConflictError('message is already being processed')

        conversation = await self._conversation_store.get_or_create(
            uow,
            f'wechaty-contact:{contact_id}',
            f'workpro-staff:{staff_userid}',
            channel='wechaty_workpro',
        )
        await self._conversation_store.append_message(
            uow,
            conversation_id=conversation.conversation_id,
            role='customer',
            content=message_text,
            external_message_id=message_id,
        )
        history = await self._conversation_store.list_recent_messages(
            uow,
            conversation.conversation_id,
            limit=self._settings.bridge_chat_history_limit,
        )
        reply = await self._generate_reply(
            history=history,
            contact_id=contact_id,
            staff_userid=staff_userid,
            message_id=message_id,
        )
        await self._conversation_store.append_message(
            uow,
            conversation_id=conversation.conversation_id,
            role='assistant',
            content=reply,
            is_ai_generated=True,
        )
        await self._audit_log.record(
            uow,
            conversation_id=conversation.conversation_id,
            handoff_required=False,
            confidence=1.0,
            citations=[],
            raw_input=message_text,
            correlation_id=correlation_id,
            payload={
                'channel': 'wechaty_workpro',
                'contact_id': contact_id,
                'staff_userid': staff_userid,
                'message_id': message_id,
                'conversation_key': conversation_key,
                'reply_length': len(reply),
            },
            event_type='bridge_chat_message',
        )
        result = BridgeChatResult(
            conversation_id=conversation.conversation_id,
            message_id=message_id,
            reply=reply,
            correlation_id=correlation_id,
        )
        await self._idempotency_store.set(uow, idempotency_key, result.to_payload())
        return result

    async def _generate_reply(
        self,
        *,
        history: list[Message],
        contact_id: str,
        staff_userid: str,
        message_id: str,
    ) -> str:
        messages = [ChatMessage(role='system', content=_SYSTEM_PROMPT)]
        for item in history[-self._settings.bridge_chat_history_limit :]:
            messages.append(
                ChatMessage(
                    role='assistant' if item.role == 'assistant' else 'user',
                    content=item.content,
                )
            )
        try:
            response = await self._llm_provider.generate(
                messages,
                timeout=self._settings.llm_timeout_seconds,
            )
        except LLMTimeoutError as exc:
            self._logger.warning(
                'bridge llm timed out',
                contact_id=contact_id,
                staff_userid=staff_userid,
                message_id=message_id,
            )
            raise UpstreamTimeoutError('bridge llm call timed out') from exc
        except LLMCallError as exc:
            self._logger.warning(
                'bridge llm failed',
                contact_id=contact_id,
                staff_userid=staff_userid,
                message_id=message_id,
            )
            raise AppError('llm_upstream_error', 'bridge llm call failed', 502) from exc

        reply = ' '.join(response.content.split())
        if not reply:
            raise AppError('empty_llm_reply', 'bridge llm returned empty reply', 502)
        return reply
