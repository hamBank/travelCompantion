#!/usr/bin/env python3
"""Daily refresh of cached trip weather.

Re-fetches every current-version WeatherCache entry so already-viewed stops stay
current and climatology days flip to live forecast as they enter the 16-day
window — without waiting for a user to open the stop. Refreshing the *existing*
keys (rather than recomputing date spans) guarantees the warmed entries match
exactly what the frontend requests.

Run via cron with DATABASE_URL set (Postgres in prod):
    cd /opt/travelcomp && export $(grep -E '^DATABASE_URL=' .env) \
        && .venv/bin/python scripts/refresh_weather.py
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session, select  # noqa: E402
from backend.database import engine  # noqa: E402
from backend.models import WeatherCache, Stop  # noqa: E402
from backend.weather import (  # noqa: E402
    get_weather as _get_weather, geocode as _geocode,
    parse_cache_key, parse_q_key, cache_key, CACHE_VERSION, _valid_coords,
)


def _stop_span(stop):
    # Date part only. DB datetimes stringify as "YYYY-MM-DD HH:MM:SS"; the
    # frontend (from JSON) uses "YYYY-MM-DDTHH:MM" — split on both separators so
    # the resulting key matches what the client requests.
    def d(v):
        return str(v).split("T")[0].split(" ")[0] if v else None
    start = d(stop.arrive)
    end = d(stop.depart) or start
    return start, end


def _q_key(location, country, start, end):
    """Build a q: cache key matching the endpoint's normalization."""
    q = ", ".join(x for x in [location, country] if x)
    qn = q.strip().lower().replace(",", " ").replace("  ", " ").strip()
    return f"{CACHE_VERSION},q:{qn},{start},{end}", q


def _upsert(session, key, data):
    row = session.get(WeatherCache, key)
    if row:
        row.payload = data
        row.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
    else:
        row = WeatherCache(cache_key=key, payload=data)
    session.add(row)


def warm_stops(session, *, get_weather=_get_weather, geocode=_geocode) -> int:
    """Proactively (re)fetch weather for EVERY stop, by arrive→depart span.

    Covers stops no one has opened yet — important in headerless mode, where the
    client wouldn't otherwise trigger a per-stop lookup. Keys mirror exactly what
    the frontend requests, so the warmed entries are the ones it reads.
    """
    stops = session.exec(select(Stop)).all()
    warmed = 0
    for stop in stops:
        start, end = _stop_span(stop)
        if not start or not end:
            continue
        coords = _valid_coords(stop.lat, stop.lng)
        if coords:
            key = cache_key(stop.lat, stop.lng, start, end)
            data = get_weather(stop.lat, stop.lng, start, end)
        else:
            if not stop.location:
                continue
            key, q = _q_key(stop.location, stop.country, start, end)
            resolved = geocode(q)
            data = get_weather(resolved[0], resolved[1], start, end) if resolved else {}
        if data:
            _upsert(session, key, data)
            warmed += 1
    session.commit()
    return warmed


def refresh_all(session: Session, *, get_weather=_get_weather, geocode=_geocode) -> int:
    """Re-fetch each current-version cache entry in place. Returns count refreshed.

    Handles both coordinate keys and place-name (q:) keys (re-geocoding the
    latter), so home/coordinate-less stops stay current too.
    """
    rows = session.exec(select(WeatherCache)).all()
    refreshed = 0
    for row in rows:
        coord = parse_cache_key(row.cache_key)
        if coord:
            lat, lng, start, end = coord
            data = get_weather(lat, lng, start, end)
        else:
            qp = parse_q_key(row.cache_key)
            if not qp:
                continue  # stale-version key — leave it
            q, start, end = qp
            resolved = geocode(q)
            data = get_weather(resolved[0], resolved[1], start, end) if resolved else {}
        if data:
            row.payload = data
            row.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session.add(row)
            refreshed += 1
    session.commit()
    return refreshed


def main() -> None:
    with Session(engine) as session:
        n = warm_stops(session)
    print(f"{datetime.now(timezone.utc):%F %T} warmed weather for {n} stop{'' if n == 1 else 's'}")


if __name__ == "__main__":
    main()
