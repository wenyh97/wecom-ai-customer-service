"""FastAPI 依赖辅助函数。"""

from __future__ import annotations

from fastapi import Request

from app.core.container import Container


def get_container(request: Request) -> Container:
    return request.app.state.container
