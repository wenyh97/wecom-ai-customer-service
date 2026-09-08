from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


def test_alembic_upgrade_head_sqlite(monkeypatch) -> None:
    root = Path(__file__).resolve().parents[1]
    runtime_dir = root / '.test-artifacts'
    runtime_dir.mkdir(exist_ok=True)
    db_path = runtime_dir / 'alembic-test.sqlite'
    if db_path.exists():
        db_path.unlink()

    monkeypatch.setenv('DATABASE_URL', f'sqlite+aiosqlite:///{db_path}')
    monkeypatch.setenv('APP_ENV', 'test')

    cfg = Config(str(root / 'alembic.ini'))
    command.upgrade(cfg, 'head')

    engine = create_engine(f'sqlite:///{db_path}')
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    assert {'tenants', 'messages', 'knowledge_documents', 'idempotency_records'} <= table_names
