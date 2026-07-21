"""Public weather endpoint backed by a variable-TTL DB cache.

Accepts coordinates directly, or a place-name query (`q`) that is geocoded when
coordinates are missing (e.g. a home stop that was never geocoded). Cache keys
are rounded coords, or `q:<name>` when geocoding, so repeated day-header renders
share an entry and we don't hammer Open-Meteo / Nominatim.

The cache TTL scales with how close the requested range is to "today": a date
range that includes today or tomorrow is genuinely volatile (live forecasts
get revised as new model runs land), so it's refreshed roughly hourly, while a
range that's already climatology-only (beyond the forecast horizon) is
essentially static — a 3-year historical average doesn't meaningfully change
run to run — so it's refreshed at most every couple of days.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..database import get_session
from ..models import WeatherCache
from ..weather import (
    get_weather, geocode, cache_key, CACHE_VERSION, FORECAST_HORIZON_DAYS, is_degraded,
    strip_invisible_chars, utc_today, get_hourly_forecast, hourly_available,
)

router = APIRouter()

# Separate cache-key namespace from the daily payloads above ("hourly:v1," vs
# "v2,") — different shape, and it would be wrong for one to ever collide
# with or overwrite the other.
HOURLY_CACHE_VERSION = "hourly:v1"

TTL_IMMEDIATE = timedelta(hours=1)   # today or tomorrow — forecasts still get revised
TTL_NEAR      = timedelta(hours=3)   # 2 days out
TTL_DEFAULT   = timedelta(hours=6)   # 3 days out through the forecast horizon
TTL_FAR       = timedelta(hours=48)  # climatology territory, or entirely in the past


def _cache_ttl(start_d: date, end_d: date, today: date) -> timedelta:
    """How long a cached entry for [start_d, end_d] stays fresh, given `today`.

    Bucketed by the closest approach of the range to `today` — a range that's
    mostly far out but starts tomorrow is exactly as volatile as one entirely
    within the next two days, since the near edge is what determines whether
    the live-forecast portion of the payload could have changed.
    """
    if end_d < today:
        return TTL_FAR  # fully in the past — nothing left to change
    days_out = max(0, (start_d - today).days)
    if days_out <= 1:
        return TTL_IMMEDIATE
    if days_out == 2:
        return TTL_NEAR
    if days_out < FORECAST_HORIZON_DAYS:
        return TTL_DEFAULT
    return TTL_FAR


def _coords(lat, lng):
    try:
        return float(str(lat).split(",")[0]), float(str(lng).split(",")[0])
    except (ValueError, TypeError, AttributeError):
        return None


@router.get("/weather")
def weather_lookup(
    start: str, end: str,
    lat: Optional[str] = None, lng: Optional[str] = None, q: Optional[str] = None,
    session: Session = Depends(get_session),
):
    have_coords = _coords(lat, lng) is not None
    if have_coords:
        key = cache_key(lat, lng, start, end)
    elif q and q.strip():
        # Strip commas (the key delimiter) and invisible chars from the place name.
        qn = strip_invisible_chars(q).strip().lower().replace(",", " ").replace("  ", " ").strip()
        key = f"{CACHE_VERSION},q:{qn},{start},{end}"
    else:
        raise HTTPException(status_code=400, detail="Provide lat/lng or q")

    # Same "today" reference as get_weather()'s horizon calculation (UTC,
    # matching Open-Meteo's own UTC-anchored validity window — NOT
    # date.today(), which follows the server process's own OS timezone;
    # production runs Europe/Berlin, not UTC) — the TTL buckets model how
    # close a date is to that same boundary, so they need to agree on what
    # "today" means.
    today = utc_today()
    start_d, end_d = date.fromisoformat(start), date.fromisoformat(end)
    ttl = _cache_ttl(start_d, end_d, today)

    cached = session.get(WeatherCache, key)
    if cached and (datetime.now(timezone.utc).replace(tzinfo=None) - cached.fetched_at) < ttl:
        return {"weather": cached.payload, "cached": True}

    # Resolve coordinates: use given ones, else geocode the place name.
    if have_coords:
        data = get_weather(lat, lng, start, end)
    else:
        resolved = geocode(q)
        data = get_weather(resolved[0], resolved[1], start, end) if resolved else {}

    # A degraded payload (upstream blip dropped in-horizon dates to
    # climatology, or nothing came back at all) is still returned to the
    # caller — stale-ish beats an error — but must not be written to the
    # cache: overwriting a good expired row with bad data would poison every
    # request for up to TTL_FAR (48h). Leave an existing row untouched so the
    # next request tries fresh instead of coasting on the old (also expired
    # but at least not wrong) entry either.
    if not is_degraded(data, start_d, end_d, today):
        if cached:
            cached.payload = data
            cached.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session.add(cached)
        else:
            session.add(WeatherCache(cache_key=key, payload=data))
        session.commit()
    return {"weather": data, "cached": False}


@router.get("/weather/hourly")
def weather_hourly(
    day: str,
    lat: Optional[str] = None, lng: Optional[str] = None, q: Optional[str] = None,
    session: Session = Depends(get_session),
):
    """Hourly breakdown + sunrise/sunset/UV/precip for one day — the
    click-through detail behind a day banner. Only ever available for a day
    within the live forecast horizon; climatology days 404 rather than
    returning a fabricated hourly shape (see get_hourly_forecast's docstring).
    """
    have_coords = _coords(lat, lng) is not None
    if not have_coords and not (q and q.strip()):
        raise HTTPException(status_code=400, detail="Provide lat/lng or q")

    today = utc_today()
    day_d = date.fromisoformat(day)
    if not hourly_available(day_d, today):
        raise HTTPException(status_code=404, detail="Hourly detail is only available within the live forecast window")

    if have_coords:
        lat_r = round(float(str(lat).split(",")[0]), 2)
        lng_r = round(float(str(lng).split(",")[0]), 2)
        key = f"{HOURLY_CACHE_VERSION},{lat_r},{lng_r},{day}"
    else:
        qn = strip_invisible_chars(q).strip().lower().replace(",", " ").replace("  ", " ").strip()
        key = f"{HOURLY_CACHE_VERSION},q:{qn},{day}"

    ttl = _cache_ttl(day_d, day_d, today)
    cached = session.get(WeatherCache, key)
    if cached and (datetime.now(timezone.utc).replace(tzinfo=None) - cached.fetched_at) < ttl:
        return {"hourly": cached.payload, "cached": True}

    if have_coords:
        data = get_hourly_forecast(lat, lng, day_d, today=today)
    else:
        resolved = geocode(q)
        data = get_hourly_forecast(resolved[0], resolved[1], day_d, today=today) if resolved else None

    if data is None:
        # Don't cache a failed fetch — leave any existing (expired but valid)
        # entry in place so the next request retries rather than 503ing again
        # off a poisoned write.
        if cached:
            return {"hourly": cached.payload, "cached": True, "stale": True}
        raise HTTPException(status_code=503, detail="Hourly forecast unavailable")

    if cached:
        cached.payload = data
        cached.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
        session.add(cached)
    else:
        session.add(WeatherCache(cache_key=key, payload=data))
    session.commit()
    return {"hourly": data, "cached": False}
