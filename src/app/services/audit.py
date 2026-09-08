"""审计日志（数据库实现）。"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.core.logging import redact_sensitive
from app.db.repository import UnitOfWork


@dataclass(frozen=True)
class AuditLogEntry:
    correlation_id: str
    conversation_id: str
    timestamp: float
    handoff_required: bool
    confidence: float
    citations: list[str]
    input_summary: str


class AuditLogStore:
    def __init__(self, *, default_tenant_slug: str, default_tenant_name: str) -> None:
        self._default_tenant_slug = default_tenant_slug
        self._default_tenant_name = default_tenant_name

    async def record(
        self,
        uow: UnitOfWork,
        *,
        raw_input: str,
        conversation_id: str | None = None,
        handoff_required: bool = False,
        confidence: float = 0.0,
        citations: list[str] | None = None,
        correlation_id: str | None = None,
        payload: dict | None = None,
        event_type: str = 'chat_message',
    ) -> AuditLogEntry:
        tenant = await uow.tenants.get_or_create(self._default_tenant_slug, self._default_tenant_name)
        tenant_id = tenant.id
        if conversation_id is not None:
            conversation = await uow.conversations.get_by_id(conversation_id)
            if conversation is not None:
                tenant_id = conversation.tenant_id
        entry = await uow.audit_logs.create(
            tenant_id=tenant_id,
            conversation_id=conversation_id,
            correlation_id=correlation_id or str(uuid.uuid4()),
            handoff_required=handoff_required,
            confidence=confidence,
            citations=citations or [],
            input_summary=redact_sensitive(raw_input)[:200],
            payload=payload or {},
            event_type=event_type,
        )
        return AuditLogEntry(
            correlation_id=entry.correlation_id,
            conversation_id=entry.conversation_id or '',
            timestamp=entry.created_at.timestamp(),
            handoff_required=entry.handoff_required,
            confidence=entry.confidence,
            citations=list(entry.citations_json),
            input_summary=entry.input_summary,
        )

    async def query(
        self,
        uow: UnitOfWork,
        conversation_id: str | None = None,
        limit: int = 50,
    ) -> list[AuditLogEntry]:
        entries = await uow.audit_logs.query(conversation_id=conversation_id, limit=limit)
        return [
            AuditLogEntry(
                correlation_id=entry.correlation_id,
                conversation_id=entry.conversation_id or '',
                timestamp=entry.created_at.timestamp(),
                handoff_required=entry.handoff_required,
                confidence=entry.confidence,
                citations=list(entry.citations_json),
                input_summary=entry.input_summary,
            )
            for entry in entries
        ]
