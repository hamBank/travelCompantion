"""Tests for the data-copy script (scripts/migrate_to_postgres.py).

Exercised SQLite → SQLite so it runs anywhere; the only Postgres-specific bit
(sequence reset) is guarded by URL and not exercised here.
"""
import sys
from pathlib import Path

from sqlmodel import SQLModel, Session, create_engine, select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import backend.models as m  # noqa: E402
from scripts.migrate_to_postgres import copy_all, _id_tables  # noqa: E402


def test_sequence_reset_skips_non_id_pk_tables():
    tables = _id_tables()
    # UserImportToken is keyed on user_email — must not be in the sequence-reset set
    assert "userimporttoken" not in tables
    # representative id-keyed tables must be present
    assert {"trip", "stop", "itineraryitem", "itemhistory"} <= set(tables)


def _seed(url: str):
    engine = create_engine(url, connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        trip = m.Trip(name="Europe 2026")
        s.add(trip)
        s.commit()
        s.refresh(trip)

        stop = m.Stop(trip_id=trip.id, location="Paris", country="France")
        s.add(stop)
        s.commit()
        s.refresh(stop)

        s.add(m.ItineraryItem(
            stop_id=stop.id, kind=m.ItemKind.flight, name="CBR → CDG",
            cost="1500 AUD", details={"depart_time": "2026-07-01T10:00", "seats": ["12A", "12B"]},
        ))
        s.add(m.TripMembership(trip_id=trip.id, user_email="a@b.com", role=m.TripRole.owner))
        s.commit()
    return engine


def test_copy_preserves_counts_ids_and_json(tmp_path):
    src_url = f"sqlite:///{tmp_path/'src.db'}"
    dst_url = f"sqlite:///{tmp_path/'dst.db'}"
    _seed(src_url)

    # Destination must have schema but no rows (mirrors alembic upgrade head).
    dst_engine = create_engine(dst_url, connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(dst_engine)

    counts = copy_all(src_url, dst_url)
    assert counts["trip"] == 1
    assert counts["stop"] == 1
    assert counts["itineraryitem"] == 1
    assert counts["tripmembership"] == 1

    with Session(dst_engine) as s:
        trip = s.exec(select(m.Trip)).one()
        stop = s.exec(select(m.Stop)).one()
        item = s.exec(select(m.ItineraryItem)).one()

        # IDs preserved so FKs still resolve
        assert stop.trip_id == trip.id
        assert item.stop_id == stop.id
        # JSON column round-trips
        assert item.details["seats"] == ["12A", "12B"]
        assert item.kind == m.ItemKind.flight


def test_empty_source_copies_nothing(tmp_path):
    src_url = f"sqlite:///{tmp_path/'empty_src.db'}"
    dst_url = f"sqlite:///{tmp_path/'empty_dst.db'}"
    for url in (src_url, dst_url):
        SQLModel.metadata.create_all(create_engine(url, connect_args={"check_same_thread": False}))

    counts = copy_all(src_url, dst_url)
    assert sum(counts.values()) == 0
