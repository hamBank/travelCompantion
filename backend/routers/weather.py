"""Public weather endpoint backed by a 6-hour DB cache.

Coordinates are rounded before keying the cache so nearby lookups (and repeated
day-header renders) share an entry and we don't hammer Open-Meteo.
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..database import get_session
from ..models import WeatherCache
from ..weather import get_weather, cache_key

router = APIRouter()

CACHE_TTL = timedelta(hours=6)


@router.get("/weather")
def weather_lookup(
    lat: str, lng: str, start: str, end: str,
    session: Session = Depends(get_session),
):
    try:
        key = cache_key(lat, lng, start, end)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid lat/lng")
    cached = session.get(WeatherCache, key)
    if cached and (datetime.utcnow() - cached.fetched_at) < CACHE_TTL:
        return {"weather": cached.payload, "cached": True}

    data = get_weather(lat, lng, start, end)

    if cached:
        cached.payload = data
        cached.fetched_at = datetime.utcnow()
        session.add(cached)
    else:
        session.add(WeatherCache(cache_key=key, payload=data))
    session.commit()
    return {"weather": data, "cached": False}
