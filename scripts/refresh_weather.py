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
from backend.weather import get_weather as _get_weather, parse_cache_key  # noqa: E402


def refresh_all(session: Session, *, get_weather=_get_weather) -> int:
    """Re-fetch each current-version cache entry in place. Returns count refreshed."""
    rows = session.exec(select(WeatherCache)).all()
    refreshed = 0
    for row in rows:
        parsed = parse_cache_key(row.cache_key)
        if not parsed:
            continue  # stale-version key — leave it (frontend won't request it)
        lat, lng, start, end = parsed
        data = get_weather(lat, lng, start, end)
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
