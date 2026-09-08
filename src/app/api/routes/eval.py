"""/eval/* 路由：评测/日志查询。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_container
from app.core.container import Container
from app.schemas.eval import AuditLogItem, AuditLogListResponse

router = APIRouter(prefix="/eval", tags=["eval"])


@router.get("/audit-logs", response_model=AuditLogListResponse)
async def list_audit_logs(
    conversation_id: str | None = Query(default=None),
    limit: int = Query(default=50, le=200),
    container: Container = Depends(get_container),
) -> AuditLogListResponse:
    entries = container.audit_log.query(conversation_id=conversation_id, limit=limit)
    return AuditLogListResponse(
        items=[
            AuditLogItem(
                correlation_id=e.correlation_id,
                conversation_id=e.conversation_id,
                timestamp=e.timestamp,
                handoff_required=e.handoff_required,
                confidence=e.confidence,
                citations=e.citations,
                input_summary=e.input_summary,
            )
            for e in entries
        ]
    )
