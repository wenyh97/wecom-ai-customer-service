"""Pydantic 请求/响应模型：/internal/chat。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class BridgeChatRequest(BaseModel):
    conversation_key: str = Field(min_length=1, max_length=255)
    contact_id: str = Field(min_length=1, max_length=255)
    staff_userid: str = Field(min_length=1, max_length=255)
    message_id: str = Field(min_length=1, max_length=255)
    text: str = Field(min_length=1, max_length=4000)


class BridgeChatResponse(BaseModel):
    conversation_id: str
    message_id: str
    reply: str
    correlation_id: str
