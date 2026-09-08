"""Pydantic 请求/响应模型：/handoff/*。"""

from __future__ import annotations

from pydantic import BaseModel


class TakeoverRequest(BaseModel):
    operator: str
    reason: str


class HandoffStatusResponse(BaseModel):
    conversation_id: str
    active: bool
    operator: str | None = None
    reason: str | None = None
