"""/eval/* 路由：评测/日志查询。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_container, get_uow
from app.core.container import Container
from app.db.repository import UnitOfWork
from app.schemas.eval import AuditLogItem, AuditLogListResponse

router = APIRouter(prefix='/eval', tags=['eval'])


@router.get('/audit-logs', response_model=AuditLogListResponse)
async def list_audit_logs(
    conversation_id: str | None = Query(default=None),
    limit: int = Query(default=50, le=200),
    container: Container = Depends(get_container),
    uow: UnitOfWork = Depends(get_uow),
) -> AuditLogListResponse:
    entries = await container.audit_log.query(uow, conversation_id=conversation_id, limit=limit)
    return AuditLogListResponse(
        items=[
            AuditLogItem(
                correlation_id=entry.correlation_id,
                conversation_id=entry.conversation_id,
                timestamp=entry.timestamp,
                handoff_required=entry.handoff_required,
                confidence=entry.confidence,
                citations=entry.citations,
                input_summary=entry.input_summary,
            )
            for entry in entries
        ]
    )
