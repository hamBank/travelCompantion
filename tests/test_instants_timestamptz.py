"""Fleet spec DB-8: instants are stored as timestamptz.

The migration (alembic/versions/a3f1c8d2e7b4_*) converts TC's 27 instant
columns with an era-aware cast. These tests pin that behaviour on a real
Postgres with a session zone that is NOT UTC (the failure only exists when the
zone differs: on a UTC server a plain `timestamp` column looks correct).
They are skipped on the SQLite run; the Postgres CI job runs them.
"""
import importlib.util
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlmodel import SQLModel

import backend.models  # noqa: F401  (registers tables)
from backend import database as database_mod

ROOT = Path(__file__).resolve().parent.parent
MIGRATION = ROOT / "alembic" / "versions" / "a3f1c8d2e7b4_store_instants_as_timestamptz.py"

pytestmark_pg = pytest.mark.skipif(
    not database_mod.DATABASE_URL.startswith("postgresql"),
    reason="needs the Postgres CI job (session time zone semantics)",
)

# A zone that is neither UTC nor Berlin, with no DST on the dates used, so the
# expected offsets below are plain arithmetic.
ZONE = "Asia/Kolkata"  # UTC+05:30 all year


def _load_migration():
    spec = importlib.util.spec_from_file_location("instants_migration", MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _model_instant_columns():
    out = set()
    for table in SQLModel.metadata.sorted_tables:
        for col in table.columns:
            if type(col.type).__name__ == "UTCDateTime":
                out.add((table.name, col.name))
    return out


def test_migration_lists_only_real_instant_columns():
    mod = _load_migration()
    listed = {(t, c) for t, c, _ in mod.COLUMNS}
    instants = _model_instant_columns()
    assert len(listed) == len(mod.COLUMNS), "duplicate column in COLUMNS"
    assert listed <= instants, f"not instant (UTCDateTime) columns: {sorted(listed - instants)}"
    # Wall-clock fields must never be converted.
    for table in SQLModel.metadata.sorted_tables:
        for col in table.columns:
            if (table.name, col.name) in listed:
                assert col.nullable == next(n for t, c, n in mod.COLUMNS if (t, c) == (table.name, col.name))


@pytest.fixture
def scratch_table():
    """A throwaway table with the same shape as an instant column."""
    engine = database_mod.engine
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE IF EXISTS tz_probe")
        conn.exec_driver_sql("CREATE TABLE tz_probe (id int primary key, ts timestamp NOT NULL, ts_null timestamp)")
    yield engine
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE IF EXISTS tz_probe")


def _run(conn, fn):
    mod = _load_migration()
    mod.COLUMNS = [("tz_probe", "ts", False), ("tz_probe", "ts_null", True)]
    ctx = MigrationContext.configure(conn)
    with Operations.context(ctx):
        getattr(mod, fn)()


@pytestmark_pg
def test_upgrade_recovers_the_instant_for_both_eras_in_a_non_utc_zone(scratch_table):
    engine = scratch_table
    with engine.begin() as conn:
        conn.exec_driver_sql(f"SET TIME ZONE '{ZONE}'")
        # Era A (before #194): the app wrote naive UTC; stored text IS the UTC instant.
        conn.exec_driver_sql("INSERT INTO tz_probe VALUES (1, '2026-06-01 10:00:00', NULL)")
        # Era B (since #194): an aware UTC datetime goes through psycopg as timestamptz and
        # Postgres stores the session-zone wall clock. Insert it the way the app does.
        aware = datetime(2026, 10, 1, 4, 0, tzinfo=timezone.utc)
        conn.execute(text("INSERT INTO tz_probe VALUES (2, :ts, :ts)"), {"ts": aware})
        stored = conn.exec_driver_sql("SELECT ts FROM tz_probe WHERE id=2").scalar()
        assert stored == datetime(2026, 10, 1, 9, 30), "precondition: wall clock in the session zone"

        _run(conn, "upgrade")

        kind = conn.exec_driver_sql(
            "SELECT data_type FROM information_schema.columns WHERE table_name='tz_probe' AND column_name='ts'"
        ).scalar()
        assert kind == "timestamp with time zone"
        # Read back as UTC regardless of the session zone.
        conn.exec_driver_sql("SET TIME ZONE 'UTC'")
        rows = dict(conn.exec_driver_sql("SELECT id, ts FROM tz_probe").all())
        assert rows[1] == datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
        assert rows[2] == datetime(2026, 10, 1, 4, 0, tzinfo=timezone.utc)
        nullable = conn.exec_driver_sql("SELECT ts_null FROM tz_probe ORDER BY id").all()
        assert nullable[0][0] is None
        assert nullable[1][0] == datetime(2026, 10, 1, 4, 0, tzinfo=timezone.utc)


@pytestmark_pg
def test_after_upgrade_writes_are_correct_in_any_zone(scratch_table):
    engine = scratch_table
    with engine.begin() as conn:
        _run(conn, "upgrade")
        for zone in ("UTC", "Europe/Berlin", ZONE):
            conn.exec_driver_sql(f"SET TIME ZONE '{zone}'")
            conn.exec_driver_sql("DELETE FROM tz_probe")
            aware = datetime(2026, 11, 6, 5, 14, tzinfo=timezone.utc)
            conn.execute(text("INSERT INTO tz_probe VALUES (1, :ts, NULL)"), {"ts": aware})
            back = conn.exec_driver_sql("SELECT ts FROM tz_probe").scalar()
            assert back == aware, zone


@pytestmark_pg
def test_downgrade_restores_session_zone_wall_clock_for_current_rows(scratch_table):
    engine = scratch_table
    with engine.begin() as conn:
        conn.exec_driver_sql(f"SET TIME ZONE '{ZONE}'")
        aware = datetime(2026, 10, 1, 4, 0, tzinfo=timezone.utc)
        conn.execute(text("INSERT INTO tz_probe VALUES (2, :ts, NULL)"), {"ts": aware})
        before = conn.exec_driver_sql("SELECT ts FROM tz_probe").scalar()
        _run(conn, "upgrade")
        _run(conn, "downgrade")
        assert conn.exec_driver_sql("SELECT ts FROM tz_probe").scalar() == before
        kind = conn.exec_driver_sql(
            "SELECT data_type FROM information_schema.columns WHERE table_name='tz_probe' AND column_name='ts'"
        ).scalar()
        assert kind == "timestamp without time zone"


@pytestmark_pg
def test_migrated_postgres_schema_matches_the_models():
    """The SQLite drift test cannot see column-type drift (SQLite has no
    timestamptz). Build a scratch Postgres database from the migrations alone
    and require autogenerate to find nothing."""
    url = make_url(database_mod.DATABASE_URL)
    name = f"tc_drift_{uuid.uuid4().hex[:8]}"
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.exec_driver_sql(f'CREATE DATABASE "{name}"')
    scratch = create_engine(url.set(database=name))
    try:
        cfg = Config(str(ROOT / "alembic.ini"))
        with scratch.connect() as conn:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")
            conn.commit()
            mc = MigrationContext.configure(conn, opts={"compare_type": True})
            diffs = compare_metadata(mc, SQLModel.metadata)
        assert not diffs, f"Postgres schema drifted from the models: {diffs}"
    finally:
        scratch.dispose()
        with admin.connect() as c:
            c.exec_driver_sql(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.dispose()
