"""Resolve a location's real IANA timezone (city/town lookup, falling back to
airport-code lookup) and compare it against a stored fixed-offset string like
"GMT+2" — used by validation.py's timezone-mismatch check.

Resolution is never done live inside a request (see CLAUDE.md's "Timezone
handling" section — this app has been burned before by mixing up which clock a
computation needs). scripts/refresh_location_timezones.py resolves and caches
locations in the background; validation.py only ever reads the cache, so an
unresolved location is silently skipped rather than guessed at or blocked on.
"""
import json
import re
import urllib.parse
import urllib.request
from datetime import date, datetime
from typing import Optional
from zoneinfo import ZoneInfo

from sqlmodel import Session

from .metrics import record_external_call
from .models import LocationTimezone
from .weather import geocode as _geocode_place

_IATA_RE = re.compile(r"^[A-Z]{3}$")

# Same fixed-offset grammar as notifications.py's _local_to_utc / frontend's
# parseTzOffsetMin — "GMT+2", "+02:00", "UTC-5", bare "8" all parse.
_FIXED_OFFSET_RE = re.compile(r"^(?:GMT|UTC)?\s*([+-]?)(\d{1,2})(?::?(\d{2}))?$", re.IGNORECASE)


def _fetch_timezone_json(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        record_external_call("open_meteo", ok=False, error=str(e))
        raise
    record_external_call("open_meteo", ok=True)
    return result


def geocode_query(location: str) -> str:
    """A bare 3-letter uppercase code is treated as an IATA airport code —
    Nominatim resolves "FCO airport" reliably but rarely the bare code alone."""
    loc = (location or "").strip()
    if _IATA_RE.match(loc):
        return f"{loc} airport"
    return loc


def fetch_iana_zone(lat: float, lng: float, *, fetch_json=_fetch_timezone_json) -> Optional[str]:
    """Open-Meteo's forecast endpoint returns a resolved IANA zone name in its
    `timezone` field whenever timezone=auto is requested — no separate
    timezone API or new dependency needed."""
    url = (
        "https://api.open-meteo.com/v1/forecast?"
        + urllib.parse.urlencode({"latitude": lat, "longitude": lng, "timezone": "auto",
                                   "forecast_days": 1})
    )
    try:
        data = fetch_json(url)
    except Exception:
        return None
    return data.get("timezone") or None


def resolve_iana_zone(location: str, *, geocode=_geocode_place, fetch_json=_fetch_timezone_json) -> Optional[str]:
    """location -> IANA zone via Nominatim geocoding + Open-Meteo. None if
    either step fails (unresolvable place name, network error, etc.)."""
    query = geocode_query(location)
    if not query:
        return None
    coords = geocode(query)
    if not coords:
        return None
    return fetch_iana_zone(coords[0], coords[1], fetch_json=fetch_json)


def get_cached_zone(session: Session, location: str) -> Optional[str]:
    """Cache-only read — never resolves live. Returns None for an unresolved
    or unresolvable location, which callers must treat as 'nothing to check'."""
    loc = (location or "").strip()
    if not loc:
        return None
    row = session.get(LocationTimezone, loc)
    return row.iana_zone if row else None


def refresh_zone_cache(session: Session, location: str, *, geocode=_geocode_place,
                        fetch_json=_fetch_timezone_json) -> Optional[str]:
    """Live-resolve `location` and upsert it into the cache. Only called from
    scripts/refresh_location_timezones.py, never from a request handler."""
    loc = (location or "").strip()
    if not loc:
        return None
    zone = resolve_iana_zone(loc, geocode=geocode, fetch_json=fetch_json)
    if not zone:
        return None
    row = session.get(LocationTimezone, loc)
    if row:
        row.iana_zone = zone
        row.resolved_at = datetime.utcnow()
    else:
        row = LocationTimezone(location=loc, iana_zone=zone)
    session.add(row)
    return zone


def parse_stored_offset_minutes(tz_str: str, on_date: date) -> Optional[int]:
    """Minutes east of UTC for a stored tz string on a given date — fixed
    offsets ("GMT+2") parse directly; a bare IANA zone name resolves via
    zoneinfo, DST-aware for that specific date (noon, to sidestep the
    transition-instant edge case on the two days a year DST actually flips)."""
    if not tz_str:
        return None
    s = str(tz_str).strip()
    m = _FIXED_OFFSET_RE.match(s)
    if m and (m.group(1) or m.group(3) is not None or m.group(2)):
        sign = -1 if m.group(1) == "-" else 1
        return sign * (int(m.group(2)) * 60 + int(m.group(3) or 0))
    try:
        offset = ZoneInfo(s).utcoffset(datetime(on_date.year, on_date.month, on_date.day, 12))
        return int(offset.total_seconds() // 60) if offset is not None else None
    except Exception:
        return None


def parse_stop_offset_minutes(stop_timezone: str) -> Optional[int]:
    """Stop.timezone is a plain hour-offset string ("2", "-5", "5.5" for a
    half-hour zone) — a different convention from the flight tz fields' "GMT+2"
    style (see backend/notifications.py:_stop_utc_offset_hours, which this
    mirrors). Model default is "0", indistinguishable from "never set" by
    sheet import, so callers must treat 0 as absent, same as that function does."""
    try:
        hours = float(str(stop_timezone or "").strip())
    except ValueError:
        return None
    return round(hours * 60)


def expected_offset_minutes(iana_zone: str, on_date: date) -> Optional[int]:
    """Real, DST-aware UTC offset for `iana_zone` on `on_date`."""
    try:
        offset = ZoneInfo(iana_zone).utcoffset(datetime(on_date.year, on_date.month, on_date.day, 12))
        return int(offset.total_seconds() // 60) if offset is not None else None
    except Exception:
        return None
