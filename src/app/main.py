"""FastAPI 应用入口。"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import chat, handoff, health, internal, kb, revisit, wecom
from app.api.routes import eval as eval_routes
from app.core.config import Settings, get_settings
from app.core.container import Container, build_container
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    container: Container | None = getattr(app.state, 'container', None)
    if container is None:
        settings = get_settings()
        configure_logging(settings.log_level)
        container = build_container(settings)
        app.state.container = container
    else:
        configure_logging(container.settings.log_level)
    await container.warmup()
    yield
    await container.close()


def create_app(settings: Settings | None = None, container: Container | None = None) -> FastAPI:
    app = FastAPI(
        title='企业微信客户 AI 客服与回访助手',
        version='0.1.0',
        lifespan=lifespan,
    )
    if container is None and settings is not None:
        container = build_container(settings)
    if container is not None:
        app.state.container = container

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(wecom.router)
    app.include_router(internal.router)
    app.include_router(chat.router)
    app.include_router(kb.router)
    app.include_router(revisit.router)
    app.include_router(handoff.router)
    app.include_router(eval_routes.router)

    return app


app = create_app()
