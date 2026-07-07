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
from ..weather import get_weather, geocode, cache_key, CACHE_VERSION, FORECAST_HORIZON_DAYS, strip_invisible_chars, utc_today

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


def _is_degraded(data: dict, start_d: date, end_d: date, today: date) -> bool:
    """True if `data` looks like a poisoned/partial fetch that must not be cached.

    Covers: a wholly empty payload (e.g. geocode failure), and — the case that
    actually bit us in prod — any date inside the live-forecast window
    [today, today+15] that came back as something other than "forecast" (a
    transient Open-Meteo error drops that date, or the whole batch, to
    climatology instead of raising). A date beyond the horizon being
    climatology is normal and not a sign of degradation.
    """
    if not data:
        return True
    horizon_end = today + timedelta(days=FORECAST_HORIZON_DAYS - 1)
    d = max(start_d, today)
    last = min(end_d, horizon_end)
    while d <= last:
        if data.get(d.isoformat(), {}).get("source") != "forecast":
            return True
        d += timedelta(days=1)
    return False


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
    if not _is_degraded(data, start_d, end_d, today):
        if cached:
            cached.payload = data
            cached.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session.add(cached)
        else:
            session.add(WeatherCache(cache_key=key, payload=data))
        session.commit()
    return {"weather": data, "cached": False}
