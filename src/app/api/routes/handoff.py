"""/handoff/* 路由：人工接管。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_container, get_uow
from app.core.container import Container
from app.db.repository import UnitOfWork
from app.schemas.handoff import HandoffStatusResponse, TakeoverRequest

router = APIRouter(prefix='/handoff', tags=['handoff'])


def _to_response(record) -> HandoffStatusResponse:
    return HandoffStatusResponse(
        conversation_id=record.conversation_id,
        active=record.active,
        operator=record.operator,
        reason=record.reason,
    )


@router.post('/{conversation_id}/takeover', response_model=HandoffStatusResponse)
async def takeover(
    conversation_id: str,
    payload: TakeoverRequest,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> HandoffStatusResponse:
    record = await container.handoffs.takeover(
        uow, conversation_id, operator=payload.operator, reason=payload.reason
    )
    await container.audit_log.record(
        uow,
        conversation_id=conversation_id,
        raw_input=payload.reason,
        correlation_id=None,
        payload={'operator': payload.operator},
        event_type='handoff_takeover',
        handoff_required=True,
    )
    await uow.commit()
    return _to_response(record)


@router.post('/{conversation_id}/release', response_model=HandoffStatusResponse)
async def release(
    conversation_id: str,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> HandoffStatusResponse:
    record = await container.handoffs.release(uow, conversation_id)
    await container.audit_log.record(
        uow,
        conversation_id=conversation_id,
        raw_input='release',
        correlation_id=None,
        payload={'operator': record.operator},
        event_type='handoff_release',
    )
    await uow.commit()
    return _to_response(record)


@router.get('/{conversation_id}', response_model=HandoffStatusResponse)
async def get_status(
    conversation_id: str,
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> HandoffStatusResponse:
    record = await container.handoffs.get(uow, conversation_id)
    return _to_response(record)
