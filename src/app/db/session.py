from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool


def build_async_engine(database_url: str, *, app_env: str = 'development') -> AsyncEngine:
    kwargs: dict[str, object] = {
        'pool_pre_ping': True,
        'future': True,
    }
    if database_url.startswith('sqlite+aiosqlite:///:memory:'):
        kwargs['poolclass'] = StaticPool
    elif database_url.startswith('sqlite+aiosqlite:///'):
        kwargs['connect_args'] = {'check_same_thread': False}
    elif database_url.startswith('mysql+asyncmy://'):
        kwargs['pool_recycle'] = 1800
        kwargs['pool_size'] = 5 if app_env != 'test' else 1
        kwargs['max_overflow'] = 10 if app_env != 'test' else 0
    return create_async_engine(database_url, **kwargs)


def build_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def ping_database(session_factory: async_sessionmaker[AsyncSession]) -> bool:
    try:
        async with session_factory() as session:
            await session.execute(text('SELECT 1'))
        return True
    except Exception:
        return False


def make_sync_database_url(database_url: str) -> str:
    url = make_url(database_url)
    if url.drivername == 'mysql+asyncmy':
        return str(url.set(drivername='mysql+pymysql'))
    if url.drivername == 'sqlite+aiosqlite':
        return str(url.set(drivername='sqlite'))
    return database_url


async def session_scope(session_factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with session_factory() as session:
        yield session
