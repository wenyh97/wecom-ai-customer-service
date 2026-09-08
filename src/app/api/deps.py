"""FastAPI 依赖辅助函数。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Depends, Request

from app.core.container import Container
from app.db.repository import UnitOfWork


def get_container(request: Request) -> Container:
    return request.app.state.container


async def get_uow(container: Container = Depends(get_container)) -> AsyncIterator[UnitOfWork]:
    async with container.uow_factory() as uow:
        yield uow
