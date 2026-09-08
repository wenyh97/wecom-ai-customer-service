"""人工接管状态记录（数据库实现）。"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.db.repository import UnitOfWork


@dataclass
class HandoffRecord:
    conversation_id: str
    active: bool = False
    operator: str | None = None
    reason: str | None = None
    started_at: float | None = None
    ended_at: float | None = None
    history: list[dict] = field(default_factory=list)


class HandoffStore:
    async def get(self, uow: UnitOfWork, conversation_id: str) -> HandoffRecord:
        record = await uow.handoffs.get_or_create(conversation_id)
        return HandoffRecord(
            conversation_id=record.conversation_id,
            active=record.active,
            operator=record.operator,
            reason=record.reason,
            started_at=None if record.started_at is None else record.started_at.timestamp(),
            ended_at=None if record.ended_at is None else record.ended_at.timestamp(),
            history=list(record.history_json),
        )

    async def takeover(self, uow: UnitOfWork, conversation_id: str, operator: str, reason: str) -> HandoffRecord:
        record = await uow.handoffs.takeover(conversation_id, operator=operator, reason=reason)
        conversation = await uow.conversations.get_by_id(conversation_id)
        if conversation is not None:
            await uow.conversations.set_status(conversation, 'handoff')
        return await self.get(uow, record.conversation_id)

    async def release(self, uow: UnitOfWork, conversation_id: str) -> HandoffRecord:
        record = await uow.handoffs.release(conversation_id)
        conversation = await uow.conversations.get_by_id(conversation_id)
        if conversation is not None:
            await uow.conversations.set_status(conversation, 'ai_active')
        return await self.get(uow, record.conversation_id)
