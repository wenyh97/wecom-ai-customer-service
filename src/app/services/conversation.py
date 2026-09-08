"""会话与消息服务（数据库实现）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from app.db.repository import UnitOfWork


@dataclass
class Message:
    role: str
    content: str
    timestamp: float


@dataclass
class Conversation:
    conversation_id: str
    customer_external_userid: str
    staff_userid: str
    status: str = 'ai_active'
    messages: list[Message] = field(default_factory=list)

    def recent_history(self, limit: int = 10) -> list[Message]:
        return self.messages[-limit:]


class ConversationStore:
    """按 (customer_external_userid, staff_userid) 维度管理会话。"""

    def __init__(self, *, default_tenant_slug: str, default_tenant_name: str) -> None:
        self._default_tenant_slug = default_tenant_slug
        self._default_tenant_name = default_tenant_name

    async def _ensure_context(
        self,
        uow: UnitOfWork,
        customer_external_userid: str,
        staff_userid: str,
    ) -> tuple[str, str, str]:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        staff = await uow.staff_users.get_or_create(tenant.id, staff_userid)
        customer = await uow.customers.get_or_create(tenant.id, customer_external_userid)
        await uow.bindings.get_or_create(tenant.id, customer.id, staff.id)
        return tenant.id, customer.id, staff.id

    async def get_or_create(
        self,
        uow: UnitOfWork,
        customer_external_userid: str,
        staff_userid: str,
        conversation_id: str | None = None,
    ) -> Conversation:
        tenant_id, customer_id, staff_id = await self._ensure_context(
            uow, customer_external_userid, staff_userid
        )
        if conversation_id:
            conversation = await uow.conversations.get_by_id(conversation_id)
            if conversation is not None:
                messages = await uow.messages.list_recent(conversation.id)
                return Conversation(
                    conversation_id=conversation.id,
                    customer_external_userid=customer_external_userid,
                    staff_userid=staff_userid,
                    status=conversation.status,
                    messages=[self._to_message(message.created_at, message.role, message.content) for message in messages],
                )
        conversation = await uow.conversations.get_or_create(tenant_id, customer_id, staff_id)
        messages = await uow.messages.list_recent(conversation.id)
        return Conversation(
            conversation_id=conversation.id,
            customer_external_userid=customer_external_userid,
            staff_userid=staff_userid,
            status=conversation.status,
            messages=[self._to_message(message.created_at, message.role, message.content) for message in messages],
        )

    async def append_message(
        self,
        uow: UnitOfWork,
        *,
        conversation_id: str,
        role: str,
        content: str,
        message_type: str = 'text',
        external_message_id: str | None = None,
        is_ai_generated: bool = False,
    ) -> Message:
        conversation = await uow.conversations.get_by_id(conversation_id)
        if conversation is None:
            raise ValueError(f'conversation {conversation_id} not found')
        message = await uow.messages.append(
            tenant_id=conversation.tenant_id,
            conversation_id=conversation_id,
            role=role,
            content=content,
            message_type=message_type,
            external_message_id=external_message_id,
            is_ai_generated=is_ai_generated,
        )
        return self._to_message(message.created_at, message.role, message.content)

    async def list_recent_messages(
        self, uow: UnitOfWork, conversation_id: str, limit: int = 10
    ) -> list[Message]:
        messages = await uow.messages.list_recent(conversation_id, limit=limit)
        return [self._to_message(message.created_at, message.role, message.content) for message in messages]

    def _to_message(self, created_at: datetime, role: str, content: str) -> Message:
        return Message(role=role, content=content, timestamp=created_at.timestamp())
