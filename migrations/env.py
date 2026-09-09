from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'src'
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from app.core.config import Settings
from app.db import models  # noqa: F401
from app.db.base import Base
from app.db.session import make_sync_database_url

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

settings = Settings()
database_url = make_sync_database_url(settings.database_url)
database_url_string = database_url.render_as_string(hide_password=False)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=database_url_string,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={'paramstyle': 'named'},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()



def run_migrations_online() -> None:
    connectable = create_engine(database_url, poolclass=pool.NullPool)

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
