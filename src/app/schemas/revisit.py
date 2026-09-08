"""Pydantic 请求/响应模型：/revisit/*。"""

from __future__ import annotations

from pydantic import BaseModel


class RevisitTaskCreateRequest(BaseModel):
    customer_external_userid: str
    reason: str
    planned_content: str


class RevisitTaskResponse(BaseModel):
    task_id: str
    customer_external_userid: str
    reason: str
    planned_content: str
    status: str
    reviewer: str | None = None
    review_comment: str | None = None


class RevisitTaskReviewRequest(BaseModel):
    decision: str  # "approve" | "reject"
    reviewer: str
    comment: str = ""
