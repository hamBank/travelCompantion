"""Alembic environment.

Wired to the application's own engine and metadata rather than a hardcoded URL
in alembic.ini, so migrations always target whatever DATABASE_URL the app uses
(SQLite locally, Postgres in production).
"""
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Engine
from alembic import context

# Import the app's engine/URL and register every table on SQLModel.metadata.
# Importing backend.models has the side effect of populating the metadata.
from backend.database import DATABASE_URL, engine
import backend.models  # noqa: F401  (registers tables)
from sqlmodel import SQLModel

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = SQLModel.metadata

# render_as_batch lets SQLite apply ALTER-heavy migrations via table copy;
# harmless on Postgres which supports ALTER natively.
_is_sqlite = DATABASE_URL.startswith("sqlite")


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_is_sqlite,
    )
    with context.begin_transaction():
        context.run_migrations()


def _run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=_is_sqlite,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    # A caller (e.g. the drift-guard test) may inject an existing Connection via
    # config.attributes["connection"]; otherwise use the app's engine.
    connectable = context.config.attributes.get("connection", None) or engine
    if isinstance(connectable, Engine):
        with connectable.connect() as connection:
            _run(connection)
    else:
        _run(connectable)  # already a Connection


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
