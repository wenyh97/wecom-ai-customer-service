"""Pydantic 请求/响应模型：/revisit/*。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class RevisitPlanCreateRequest(BaseModel):
    customer_external_userid: str
    name: str
    reason: str
    schedule_rule: str | None = None
    metadata: dict = Field(default_factory=dict)


class RevisitPlanResponse(BaseModel):
    plan_id: str
    customer_external_userid: str
    name: str
    reason: str
    schedule_rule: str | None = None
    status: str
    metadata: dict = Field(default_factory=dict)


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
    comment: str = ''
