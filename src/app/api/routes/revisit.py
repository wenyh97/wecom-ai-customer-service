"""/revisit/* 路由：回访计划与任务。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_container, get_uow
from app.core.container import Container
from app.core.errors import AppError
from app.db.repository import UnitOfWork
from app.schemas.revisit import (
    RevisitPlanCreateRequest,
    RevisitPlanResponse,
    RevisitTaskCreateRequest,
    RevisitTaskResponse,
    RevisitTaskReviewRequest,
)

router = APIRouter(prefix='/revisit', tags=['revisit'])


def _task_to_response(task) -> RevisitTaskResponse:
    return RevisitTaskResponse(
        task_id=task.task_id,
        customer_external_userid=task.customer_external_userid,
        reason=task.reason,
        planned_content=task.planned_content,
        status=task.status,
        reviewer=task.reviewer,
        review_comment=task.review_comment,
    )


def _plan_to_response(plan) -> RevisitPlanResponse:
    return RevisitPlanResponse(
        plan_id=plan.plan_id,
        customer_external_userid=plan.customer_external_userid,
        name=plan.name,
        reason=plan.reason,
        schedule_rule=plan.schedule_rule,
        status=plan.status,
        metadata=plan.metadata,
    )


@router.post('/plans', response_model=RevisitPlanResponse)
async def create_plan(
    payload: RevisitPlanCreateRequest,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> RevisitPlanResponse:
    plan = await container.revisit_tasks.create_plan(
        uow,
        customer_external_userid=payload.customer_external_userid,
        name=payload.name,
        reason=payload.reason,
        schedule_rule=payload.schedule_rule,
        metadata=payload.metadata,
    )
    await container.audit_log.record(
        uow,
        raw_input=payload.reason,
        event_type='revisit_plan_create',
        payload={
            'customer_external_userid': payload.customer_external_userid,
            'name': payload.name,
            'schedule_rule': payload.schedule_rule,
        },
    )
    await uow.commit()
    return _plan_to_response(plan)


@router.get('/plans', response_model=list[RevisitPlanResponse])
async def list_plans(
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> list[RevisitPlanResponse]:
    plans = await container.revisit_tasks.list_plans(uow)
    return [_plan_to_response(plan) for plan in plans]


@router.post('/tasks', response_model=RevisitTaskResponse)
async def create_task(
    payload: RevisitTaskCreateRequest,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> RevisitTaskResponse:
    task = await container.revisit_tasks.create(
        uow,
        customer_external_userid=payload.customer_external_userid,
        reason=payload.reason,
        planned_content=payload.planned_content,
    )
    await container.audit_log.record(
        uow,
        raw_input=payload.reason,
        event_type='revisit_task_create',
        payload={'customer_external_userid': payload.customer_external_userid},
    )
    await uow.commit()
    return _task_to_response(task)


@router.get('/tasks', response_model=list[RevisitTaskResponse])
async def list_tasks(
    status: str | None = Query(default=None),
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> list[RevisitTaskResponse]:
    tasks = await container.revisit_tasks.list_by_status(uow, status)
    return [_task_to_response(task) for task in tasks]


@router.post('/tasks/{task_id}/review', response_model=RevisitTaskResponse)
async def review_task(
    task_id: str,
    payload: RevisitTaskReviewRequest,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> RevisitTaskResponse:
    task = await container.revisit_tasks.review(
        uow, task_id, payload.decision, payload.reviewer, payload.comment
    )
    await container.audit_log.record(
        uow,
        raw_input=payload.comment or payload.decision,
        event_type='revisit_task_review',
        payload={'task_id': task_id, 'reviewer': payload.reviewer, 'decision': payload.decision},
    )
    await uow.commit()
    return _task_to_response(task)


@router.post('/tasks/{task_id}/send', response_model=RevisitTaskResponse)
async def send_task(
    task_id: str,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> RevisitTaskResponse:
    task = await container.revisit_tasks.get(uow, task_id)
    if task.status != 'approved':
        raise AppError(
            'invalid_state', 'only approved tasks can be sent', status_code=409
        )
    task = await container.revisit_tasks.mark_sent(uow, task_id, success=True)
    await container.audit_log.record(
        uow,
        raw_input='send revisit task',
        event_type='revisit_task_send',
        payload={'task_id': task_id, 'status': task.status},
    )
    await uow.commit()
    return _task_to_response(task)
