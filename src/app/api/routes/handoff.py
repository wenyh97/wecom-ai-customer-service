"""/handoff/* 路由：人工接管。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_container
from app.core.container import Container
from app.schemas.handoff import HandoffStatusResponse, TakeoverRequest

router = APIRouter(prefix="/handoff", tags=["handoff"])


def _to_response(record) -> HandoffStatusResponse:
    return HandoffStatusResponse(
        conversation_id=record.conversation_id,
        active=record.active,
        operator=record.operator,
        reason=record.reason,
    )


@router.post("/{conversation_id}/takeover", response_model=HandoffStatusResponse)
async def takeover(
    conversation_id: str,
    payload: TakeoverRequest,
    container: Container = Depends(get_container),
) -> HandoffStatusResponse:
    record = container.handoffs.takeover(
        conversation_id, operator=payload.operator, reason=payload.reason
    )
    return _to_response(record)


@router.post("/{conversation_id}/release", response_model=HandoffStatusResponse)
async def release(
    conversation_id: str, container: Container = Depends(get_container)
) -> HandoffStatusResponse:
    record = container.handoffs.release(conversation_id)
    return _to_response(record)


@router.get("/{conversation_id}", response_model=HandoffStatusResponse)
async def get_status(
    conversation_id: str, container: Container = Depends(get_container)
) -> HandoffStatusResponse:
    record = container.handoffs.get(conversation_id)
    return _to_response(record)
