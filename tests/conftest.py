"""共享测试 fixture。"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.container import Container, build_container
from app.db.base import Base
from app.main import create_app


async def _create_schema(container: Container) -> None:
    async with container.engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        app_env='test',
        database_url='sqlite+aiosqlite:///:memory:',
        llm_api_key='',
        embedding_api_key='',
        wecom_token='test-token',
        wecom_aes_key='',
        handoff_confidence_threshold=0.1,
    )


@pytest.fixture
def container(settings: Settings) -> Container:
    test_container = build_container(settings)
    asyncio.run(_create_schema(test_container))
    yield test_container
    asyncio.run(test_container.close())


@pytest.fixture
def client(container: Container) -> TestClient:
    app = create_app(container=container)
    with TestClient(app) as test_client:
        yield test_client
