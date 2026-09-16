#!/usr/bin/env python3
"""One-off cleanup: null out every cached LocationTimezone.country so the
next refresh_location_timezones.py run re-resolves it in English.

Only needed once, for rows resolved before that script's geocode request
picked up accept-language=en (see backend/weather.py) — those rows are
stuck with Nominatim's local-language country name (e.g. "Sverige",
"Nederland"), which doesn't match countryFlag.js's English-keyed FLAGS map
and silently renders no flag. iana_zone is left untouched — it isn't
language-dependent, so there's nothing wrong with it to reset.

Run with DATABASE_URL set (Postgres in prod):
    cd /opt/travelcomp && export $(grep -E '^DATABASE_URL=' .env) \
        && .venv/bin/python scripts/reset_location_country_cache.py

Then trigger a fresh resolve pass (or wait for the daily timer):
    sudo systemctl start travelcomp-loctz.service
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlmodel import Session, select  # noqa: E402
from backend.database import engine  # noqa: E402
from backend.models import LocationTimezone  # noqa: E402


def reset_all_countries(session: Session) -> int:
    rows = session.exec(select(LocationTimezone).where(LocationTimezone.country.is_not(None))).all()
    for row in rows:
        row.country = None
        session.add(row)
    session.commit()
    return len(rows)


def main() -> None:
    with Session(engine) as session:
        n = reset_all_countries(session)
    print(f"Cleared country on {n} location{'' if n == 1 else 's'} — "
          f"run scripts/refresh_location_timezones.py (or the loctz timer) to re-resolve.")


if __name__ == "__main__":
    main()
