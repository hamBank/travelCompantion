"""Drift guard: the SQLModel models must match the Alembic migration chain.

conftest builds the test schema with SQLModel.metadata.create_all() for speed,
which means the migrations could silently rot. This test runs the real
migrations onto a throwaway SQLite DB and asserts autogenerate finds no
difference against the models — failing loudly the moment someone edits a model
without writing a revision.
"""
import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlmodel import SQLModel

import backend.models  # noqa: F401  (registers tables on SQLModel.metadata)

alembic = pytest.importorskip("alembic")
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from alembic.runtime.migration import MigrationContext  # noqa: E402
from alembic.autogenerate import compare_metadata  # noqa: E402

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_models_match_migrations(tmp_path):
    db_path = tmp_path / "drift.db"
    engine: Engine = create_engine(f"sqlite:///{db_path}")

    cfg = Config(os.path.join(_ROOT, "alembic.ini"))
    with engine.connect() as conn:
        # env.py honours an injected connection over the app engine, so the
        # migrations land on this temp DB rather than the real travel.db.
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")

        mc = MigrationContext.configure(
            conn, opts={"compare_type": True, "render_as_batch": True}
        )
        diffs = compare_metadata(mc, SQLModel.metadata)

    assert not diffs, (
        "Models have drifted from the Alembic migrations. Generate a revision:\n"
        "  alembic revision --autogenerate -m '<describe change>'\n"
        f"Diffs: {diffs}"
    )
