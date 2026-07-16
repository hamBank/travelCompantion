#!/usr/bin/env python3
"""Resolve and cache the real IANA timezone for every flight origin/destination
and stop location seen in the DB, so validation.py's timezone-mismatch check
has something to compare against. Locations are effectively permanent, so this
only resolves what's missing from LocationTimezone — no re-fetching, no TTL.

Run via cron with DATABASE_URL set (Postgres in prod):
    cd /opt/travelcomp && export $(grep -E '^DATABASE_URL=' .env) \
        && .venv/bin/python scripts/refresh_location_timezones.py
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session, select  # noqa: E402
from backend.database import engine  # noqa: E402
from backend.models import ItineraryItem, ItemKind, LocationTimezone, Stop  # noqa: E402
from backend.tz_check import refresh_zone_cache  # noqa: E402


def pending_locations(session: Session) -> set[str]:
    """Every distinct flight origin/destination and stop location not already
    cached. Stops are resolved regardless of whether Stop.timezone is set —
    the check only *compares* against a set timezone, but caching every stop's
    real offset up front means a newly-entered timezone is checkable
    immediately rather than waiting on the airport-only demand-driven path."""
    items = session.exec(select(ItineraryItem).where(ItineraryItem.kind == ItemKind.flight)).all()
    locations = set()
    for it in items:
        d = it.details or {}
        for key in ("origin", "destination"):
            loc = (d.get(key) or "").strip()
            if loc:
                locations.add(loc)
    stops = session.exec(select(Stop)).all()
    for stop in stops:
        loc = (stop.location or "").strip()
        if loc:
            locations.add(loc)
    if not locations:
        return set()
    cached = session.exec(
        select(LocationTimezone.location).where(LocationTimezone.location.in_(locations))
    ).all()
    return locations - set(cached)


def refresh_all(session: Session, *, geocode=None, fetch_json=None) -> int:
    """Resolve every not-yet-cached location. Returns count newly resolved.
    A location that fails to resolve (bad geocode, network error) is simply
    skipped — it'll be retried on the next run, not treated as a failure."""
    kwargs = {}
    if geocode is not None:
        kwargs["geocode"] = geocode
    if fetch_json is not None:
        kwargs["fetch_json"] = fetch_json

    resolved = 0
    for loc in pending_locations(session):
        if refresh_zone_cache(session, loc, **kwargs):
            resolved += 1
    session.commit()
    return resolved


def main() -> None:
    with Session(engine) as session:
        n = refresh_all(session)
    print(f"{datetime.now(timezone.utc):%F %T} resolved timezone for {n} location{'' if n == 1 else 's'}")


if __name__ == "__main__":
    main()
