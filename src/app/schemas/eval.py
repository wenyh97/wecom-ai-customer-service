"""Pydantic 响应模型：/eval/*。"""

from __future__ import annotations

from pydantic import BaseModel


class AuditLogItem(BaseModel):
    correlation_id: str
    conversation_id: str
    timestamp: float
    handoff_required: bool
    confidence: float
    citations: list[str]
    input_summary: str


class AuditLogListResponse(BaseModel):
    items: list[AuditLogItem]
