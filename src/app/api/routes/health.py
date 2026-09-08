"""/health 路由。"""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request) -> dict:
    settings = request.app.state.container.settings
    return {"status": "ok", "version": settings.version}
