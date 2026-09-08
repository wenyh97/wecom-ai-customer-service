"""/revisit/* 路由：回访计划与任务。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_container
from app.core.container import Container
from app.core.errors import AppError
from app.schemas.revisit import (
    RevisitTaskCreateRequest,
    RevisitTaskResponse,
    RevisitTaskReviewRequest,
)

router = APIRouter(prefix="/revisit", tags=["revisit"])


def _to_response(task) -> RevisitTaskResponse:
    return RevisitTaskResponse(
        task_id=task.task_id,
        customer_external_userid=task.customer_external_userid,
        reason=task.reason,
        planned_content=task.planned_content,
        status=task.status,
        reviewer=task.reviewer,
        review_comment=task.review_comment,
    )


@router.post("/tasks", response_model=RevisitTaskResponse)
async def create_task(
    payload: RevisitTaskCreateRequest, container: Container = Depends(get_container)
) -> RevisitTaskResponse:
    task = container.revisit_tasks.create(
        customer_external_userid=payload.customer_external_userid,
        reason=payload.reason,
        planned_content=payload.planned_content,
    )
    return _to_response(task)


@router.get("/tasks", response_model=list[RevisitTaskResponse])
async def list_tasks(
    status: str | None = Query(default=None),
    container: Container = Depends(get_container),
) -> list[RevisitTaskResponse]:
    tasks = container.revisit_tasks.list_by_status(status)
    return [_to_response(t) for t in tasks]


@router.post("/tasks/{task_id}/review", response_model=RevisitTaskResponse)
async def review_task(
    task_id: str,
    payload: RevisitTaskReviewRequest,
    container: Container = Depends(get_container),
) -> RevisitTaskResponse:
    task = container.revisit_tasks.review(
        task_id, payload.decision, payload.reviewer, payload.comment
    )
    return _to_response(task)


@router.post("/tasks/{task_id}/send", response_model=RevisitTaskResponse)
async def send_task(
    task_id: str, container: Container = Depends(get_container)
) -> RevisitTaskResponse:
    task = container.revisit_tasks.get(task_id)
    if task.status != "approved":
        raise AppError(
            "invalid_state", "only approved tasks can be sent", status_code=409
        )
    # 占位实现：真实发送需对接企业微信官方 API（TODO(confirm-with-wecom-docs)）
    task = container.revisit_tasks.mark_sent(task_id, success=True)
    return _to_response(task)
