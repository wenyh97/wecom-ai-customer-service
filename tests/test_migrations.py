from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import make_url

from app.db.session import make_sync_database_url


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


def test_make_sync_database_url_preserves_special_character_password() -> None:
    password = "p@ss:/?#[]!$&'()*+,;=%"
    encoded_password = quote(password, safe='')

    sync_url = make_sync_database_url(
        f'mysql+asyncmy://wecom_ai:{encoded_password}@mysql:3306/wecom_ai?charset=utf8mb4'
    )

    assert sync_url.drivername == 'mysql+pymysql'
    assert sync_url.password == password
    assert make_url(sync_url.render_as_string(hide_password=False)).password == password
