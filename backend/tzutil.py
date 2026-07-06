"""Lightweight longitude-based local-day approximation.

Real timezone boundaries don't follow longitude exactly (political borders,
DST, etc.), but for deciding *which calendar day it currently is* somewhere —
which is all callers here need, accurate to within an hour or two — a
longitude-based UTC offset is more than sufficient. This avoids pulling in a
full tz-database dependency (e.g. timezonefinder, a ~50MB wheel) for a purpose
that never needs an exact zone name or DST rules.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


def approx_utc_offset_hours(lng: float) -> int:
    """Rough UTC offset for a longitude: 15 degrees per hour, clamped to real limits."""
    return max(-12, min(14, round(lng / 15)))


def local_today(lng: float | None, *, now: datetime | None = None) -> date:
    """Approximate calendar date at `lng` right now (or at `now`, if given)."""
    now = now or datetime.now(timezone.utc)
    if lng is None:
        return now.date()
    offset = approx_utc_offset_hours(lng)
    return (now + timedelta(hours=offset)).date()
