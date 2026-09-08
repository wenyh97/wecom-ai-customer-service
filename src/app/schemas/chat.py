"""Pydantic 请求/响应模型：/chat/messages。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ChatMessageRequest(BaseModel):
    conversation_id: str | None = None
    customer_external_userid: str
    staff_userid: str
    content: str
    message_type: str = "text"
    idempotency_key: str | None = None


class Citation(BaseModel):
    source_id: str
    title: str
    score: float


class ChatMessageResponse(BaseModel):
    conversation_id: str
    reply: str | None
    handoff_required: bool
    confidence: float
    citations: list[Citation] = Field(default_factory=list)
    correlation_id: str
