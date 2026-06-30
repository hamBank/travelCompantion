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
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session, select  # noqa: E402
from backend.database import engine  # noqa: E402
from backend.models import WeatherCache  # noqa: E402
from backend.weather import (  # noqa: E402
    get_weather as _get_weather, geocode as _geocode, parse_cache_key, parse_q_key,
)


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
            row.fetched_at = datetime.utcnow()
            session.add(row)
            refreshed += 1
    session.commit()
    return refreshed


def main() -> None:
    with Session(engine) as session:
        n = refresh_all(session)
    print(f"{datetime.utcnow():%F %T} refreshed {n} weather cache entr{'y' if n == 1 else 'ies'}")


if __name__ == "__main__":
    main()
