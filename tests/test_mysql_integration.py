from __future__ import annotations

import os

import pytest
from sqlalchemy import text

from app.core.config import Settings
from app.core.container import build_container


@pytest.mark.asyncio
async def test_mysql_integration_round_trip() -> None:
    database_url = os.getenv('MYSQL_TEST_DATABASE_URL')
    if not database_url:
        pytest.skip('MYSQL_TEST_DATABASE_URL not set')

    container = build_container(
        Settings(
            _env_file=None,
            app_env='test',
            database_url=database_url,
            llm_api_key='',
            embedding_api_key='',
        )
    )
    try:
        async with container.uow_factory() as uow:
            result = await uow.session.execute(text('SELECT 1'))
            assert result.scalar_one() == 1
            tenant_count = await uow.session.execute(text('SELECT COUNT(*) FROM tenants'))
            assert tenant_count.scalar_one() >= 0
    finally:
        await container.close()
