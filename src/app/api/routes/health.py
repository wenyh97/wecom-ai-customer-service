"""/health 路由。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse

from app.api.deps import get_container
from app.core.container import Container
from app.db.session import ping_database

router = APIRouter(tags=['health'])


@router.get('/health')
async def health(container: Container = Depends(get_container)) -> JSONResponse:
    db_ok = await ping_database(container.session_factory)
    payload = {
        'status': 'ok' if db_ok else 'degraded',
        'version': container.settings.version,
        'dependencies': {
            'application': 'ok',
            'database': 'ok' if db_ok else 'unavailable',
            'redis': 'reserved',
        },
    }
    return JSONResponse(
        status_code=status.HTTP_200_OK if db_ok else status.HTTP_503_SERVICE_UNAVAILABLE,
        content=payload,
    )
