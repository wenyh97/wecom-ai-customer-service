"""审计日志（内存实现）。

存储的字段遵循最小化原则：`input_summary` 应为脱敏后的摘要，
不应包含客户隐私原文（见 docs/observability-evaluation.md）。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from app.core.logging import redact_sensitive


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
    def __init__(self) -> None:
        self._entries: list[AuditLogEntry] = []

    def record(
        self,
        *,
        conversation_id: str,
        handoff_required: bool,
        confidence: float,
        citations: list[str],
        raw_input: str,
        correlation_id: str | None = None,
    ) -> AuditLogEntry:
        entry = AuditLogEntry(
            correlation_id=correlation_id or str(uuid.uuid4()),
            conversation_id=conversation_id,
            timestamp=time.time(),
            handoff_required=handoff_required,
            confidence=confidence,
            citations=citations,
            input_summary=redact_sensitive(raw_input)[:200],
        )
        self._entries.append(entry)
        return entry

    def query(
        self,
        conversation_id: str | None = None,
        limit: int = 50,
    ) -> list[AuditLogEntry]:
        entries = self._entries
        if conversation_id is not None:
            entries = [e for e in entries if e.conversation_id == conversation_id]
        return list(reversed(entries))[:limit]
