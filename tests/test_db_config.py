"""Tests for dialect-agnostic engine configuration in database.py.

The connect_args that SQLite needs (check_same_thread, timeout) are invalid for
Postgres' driver, so they must only be applied for sqlite URLs.
"""
from backend.database import _connect_args


def test_sqlite_url_gets_sqlite_connect_args():
    args = _connect_args("sqlite:///./travel.db")
    assert args["check_same_thread"] is False
    assert args["timeout"] == 30


def test_postgres_url_gets_no_sqlite_connect_args():
    args = _connect_args("postgresql+psycopg://u:p@localhost/travelcomp")
    assert "check_same_thread" not in args
    assert "timeout" not in args
    assert args == {}


def test_plain_postgres_url_also_clean():
    assert _connect_args("postgresql://u:p@localhost/travelcomp") == {}
