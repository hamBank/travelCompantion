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
from ..weather import get_weather, geocode, cache_key, CACHE_VERSION, FORECAST_HORIZON_DAYS
from ..tzutil import local_today

router = APIRouter()

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
    coords = _coords(lat, lng)
    have_coords = coords is not None
    if have_coords:
        key = cache_key(lat, lng, start, end)
    elif q and q.strip():
        # Strip commas (the key delimiter) from the place name.
        qn = q.strip().lower().replace(",", " ").replace("  ", " ").strip()
        key = f"{CACHE_VERSION},q:{qn},{start},{end}"
    else:
        raise HTTPException(status_code=400, detail="Provide lat/lng or q")

    # Geocoding happens below only on a cache miss, so for a q-only lookup we
    # don't yet know its longitude here — fall back to the server's own date
    # for the TTL bucket in that case. Off by a day at worst (harmless: it
    # only ever shifts which bucket applies, never a service-breaking error
    # like the forecast-horizon calculation in get_weather()).
    today = local_today(coords[1] if have_coords else None)
    ttl = _cache_ttl(date.fromisoformat(start), date.fromisoformat(end), today)

    cached = session.get(WeatherCache, key)
    if cached and (datetime.now(timezone.utc).replace(tzinfo=None) - cached.fetched_at) < ttl:
        return {"weather": cached.payload, "cached": True}

    # Resolve coordinates: use given ones, else geocode the place name.
    if have_coords:
        data = get_weather(lat, lng, start, end)
    else:
        resolved = geocode(q)
        data = get_weather(resolved[0], resolved[1], start, end) if resolved else {}

    if cached:
        cached.payload = data
        cached.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
        session.add(cached)
    else:
        session.add(WeatherCache(cache_key=key, payload=data))
    session.commit()
    return {"weather": data, "cached": False}
