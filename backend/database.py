from sqlmodel import create_engine, Session, SQLModel
from sqlalchemy import text

DATABASE_URL = "sqlite:///./travel.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False, "timeout": 30})


def get_session():
    with Session(engine) as session:
        yield session


def create_db_and_tables():
    SQLModel.metadata.create_all(engine)
    _migrate()
    _backfill_accommodations()
    _backfill_trip_ownership()


def _migrate():
    """Apply additive schema changes to existing databases."""
    new_columns = [
        "ALTER TABLE trip ADD COLUMN start_date DATETIME",
        "ALTER TABLE trip ADD COLUMN end_date DATETIME",
        "ALTER TABLE itineraryitem ADD COLUMN details TEXT",
    ]
    with engine.connect() as conn:
        for sql in new_columns:
            try:
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
