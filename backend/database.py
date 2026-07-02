import os
import time
from sqlmodel import create_engine, Session, SQLModel
from sqlalchemy import text, event
from sqlalchemy.orm import Session as _SASession

# Default to the local SQLite file; override with DATABASE_URL in production
# (e.g. postgresql+psycopg://user:pass@host/travelcomp).
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./travel.db")


def _connect_args(url: str) -> dict:
    """Driver connect_args that only make sense for SQLite.

    check_same_thread/timeout are SQLite-specific; passing them to psycopg
    raises. Returns an empty dict for any non-sqlite URL.
    """
    if url.startswith("sqlite"):
        return {"check_same_thread": False, "timeout": 30}
    return {}


engine = create_engine(DATABASE_URL, connect_args=_connect_args(DATABASE_URL))


# ── data_version: a process-wide counter that advances on every write ──────────
# Backs the cross-device sync poller (see /health). Seeded from the wall clock so
# it keeps moving forward across process restarts, then bumped by the after_flush
# listener below whenever a session flushes inserts/updates/deletes. This is
# storage-agnostic — it works identically on SQLite and Postgres because it
# observes ORM activity rather than a database file's mtime.
_DATA_VERSION = int(time.time() * 1000)


def get_data_version() -> int:
    return _DATA_VERSION


@event.listens_for(_SASession, "after_flush")
def _bump_data_version(session, flush_context):
    changed = list(session.new) + list(session.dirty) + list(session.deleted)
    if not changed:
        return
    # WeatherCache is a read-through cache, not trip data — a cache fill/miss
    # doesn't belong in any client-facing payload (timeline responses never
    # embed weather), so it shouldn't make every open trip's sync poller
    # refetch. Only skip the bump when the flush is *entirely* cache writes;
    # a real trip-data change alongside one still counts normally.
    from .models import WeatherCache
    if all(isinstance(obj, WeatherCache) for obj in changed):
        return
    global _DATA_VERSION
    _DATA_VERSION += 1


def get_session():
    with Session(engine) as session:
        yield session


def create_db_and_tables():
    # On SQLite (dev/test) the app owns schema creation for convenience.
    # On Postgres, Alembic owns the schema — `alembic upgrade head` runs at
    # deploy time before the service starts, so we must NOT create_all here or
    # it would collide with Alembic's own CREATE TABLEs. Data backfills are
    # idempotent and run on both.
    if DATABASE_URL.startswith("sqlite"):
        SQLModel.metadata.create_all(engine)
        _migrate()
    _backfill_accommodations()
    _backfill_trip_ownership()


def _migrate():
    """Apply additive schema changes to existing databases.

    Each statement runs in its own connection/transaction: on Postgres a failed
    ALTER (column already exists) aborts the current transaction, so a shared
    connection would poison every subsequent statement. A fresh connection per
    statement keeps the "try, ignore-if-exists" pattern working on both engines.

    NOTE: new schema changes should be added as Alembic revisions, not here.
    This remains only to carry pre-Alembic databases forward.
    """
    new_columns = [
        "ALTER TABLE trip ADD COLUMN start_date DATETIME",
        "ALTER TABLE trip ADD COLUMN end_date DATETIME",
        "ALTER TABLE itineraryitem ADD COLUMN details TEXT",
    ]
    for sql in new_columns:
        try:
            with engine.connect() as conn:
                conn.execute(text(sql))
                conn.commit()
        except Exception:
            pass  # column already exists


def _backfill_accommodations():
    """One-time data migration: move legacy stop.accommodation fields to ItineraryItem records."""
    try:
        from .models import Stop, ItineraryItem, ItemKind, ItemStatus
        from .importer import _combine_checkinout
        from sqlmodel import select

        with Session(engine) as session:
            stops = session.exec(select(Stop)).all()
            created = 0
            for stop in stops:
                if not stop.accommodation:
                    continue
                existing = session.exec(
                    select(ItineraryItem)
                    .where(ItineraryItem.stop_id == stop.id)
                    .where(ItineraryItem.kind == ItemKind.accommodation)
                ).first()
                if existing:
                    continue

                details: dict = {}
                if stop.accommodation_notes:
                    details["description"] = stop.accommodation_notes
                ci = _combine_checkinout(stop.arrive, stop.check_in)
                if ci:
                    details["checkin"] = ci
                co = _combine_checkinout(stop.depart, stop.check_out)
                if co:
                    details["checkout"] = co

                session.add(ItineraryItem(
                    stop_id=stop.id,
                    kind=ItemKind.accommodation,
                    name=stop.accommodation,
                    link=stop.accommodation_link or "",
                    scheduled_at=stop.arrive,
                    status=ItemStatus.pending,
                    details=details or None,
                ))
                created += 1

            if created:
                session.commit()
                print(f"[migrate] created {created} accommodation item(s) from legacy stop fields")
    except Exception as e:
        print(f"[migrate] _backfill_accommodations failed: {e}")


def _backfill_trip_ownership():
    """Give every trip without any membership an owner. Uses ALLOWED_EMAIL (the
    single existing user) so pre-permissions trips remain accessible."""
    try:
        import os
        from .models import Trip, TripMembership, TripRole
        from sqlmodel import select

        owner_email = os.environ.get("ALLOWED_EMAIL", "").lower()
        if not owner_email:
            return  # nothing to assign to (auth-disabled / no configured user)

        with Session(engine) as session:
            trips = session.exec(select(Trip)).all()
            created = 0
            for trip in trips:
                has_member = session.exec(
                    select(TripMembership).where(TripMembership.trip_id == trip.id)
                ).first()
                if has_member:
                    continue
                session.add(TripMembership(
                    trip_id=trip.id, user_email=owner_email, role=TripRole.owner,
                ))
                created += 1
            if created:
                session.commit()
                print(f"[migrate] assigned {created} trip(s) to owner {owner_email}")
    except Exception as e:
        print(f"[migrate] _backfill_trip_ownership failed: {e}")
