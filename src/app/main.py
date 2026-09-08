"""FastAPI 应用入口。"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import chat, handoff, health, kb, revisit, wecom
from app.api.routes import eval as eval_routes
from app.core.config import get_settings
from app.core.container import build_container
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    app.state.container = build_container(settings)
    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="企业微信客户 AI 客服与回访助手",
        version="0.1.0",
        lifespan=lifespan,
    )

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(wecom.router)
    app.include_router(chat.router)
    app.include_router(kb.router)
    app.include_router(revisit.router)
    app.include_router(handoff.router)
    app.include_router(eval_routes.router)

    return app


app = create_app()
