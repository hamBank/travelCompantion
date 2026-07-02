"""Public weather endpoint backed by a 6-hour DB cache.

Accepts coordinates directly, or a place-name query (`q`) that is geocoded when
coordinates are missing (e.g. a home stop that was never geocoded). Cache keys
are rounded coords, or `q:<name>` when geocoding, so repeated day-header renders
share an entry and we don't hammer Open-Meteo / Nominatim.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..database import get_session
from ..models import WeatherCache
from ..weather import get_weather, geocode, cache_key, CACHE_VERSION

router = APIRouter()

CACHE_TTL = timedelta(hours=6)


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
        # Strip commas (the key delimiter) from the place name.
        qn = q.strip().lower().replace(",", " ").replace("  ", " ").strip()
        key = f"{CACHE_VERSION},q:{qn},{start},{end}"
    else:
        raise HTTPException(status_code=400, detail="Provide lat/lng or q")

    cached = session.get(WeatherCache, key)
    if cached and (datetime.now(timezone.utc).replace(tzinfo=None) - cached.fetched_at) < CACHE_TTL:
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
