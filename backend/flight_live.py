"""Live flight lookups via AeroDataBox.

Extracted from backend/routers/items.py's check_flight so both the flight-
check endpoint and the notifications cron (backend/notifications.py) can
fetch live status without a circular import between those two modules.
"""
import os
from datetime import datetime
from typing import Optional
import httpx

from .metrics import record_external_call
from .rate_limit import throttle

AERODATABOX_KEY = os.getenv("AERODATABOX_KEY", "")
_AERODATABOX_BASE = "https://aerodatabox.p.rapidapi.com"


class FlightLiveError(Exception):
    """Raised when AeroDataBox is unreachable, or returns a non-2xx or
    non-JSON response. str(e) is a caller-facing detail message."""


def _parse_local_scheduled(local_str: Optional[str]) -> Optional[datetime]:
    """AeroDataBox local time '2026-07-24 21:35+08:00' -> naive
    datetime(2026,7,24,21,35) — the offset is dropped since it's meant to
    represent the same local wall-clock value we store ourselves."""
    if not local_str:
        return None
    try:
        return datetime.strptime(local_str[:16], "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def _best_match(flights: list, stored_depart: Optional[str]) -> Optional[dict]:
    """AeroDataBox's number+date endpoint isn't guaranteed to return exactly
    one flight for a given number/date — a reused flight number, or their
    date bucketing landing on a different UTC/local day than expected, can
    both surface more than one candidate. Blindly taking the first one risks
    handing back an already-departed (or already-landed) instance of the same
    flight number while the one actually stored on this item hasn't left yet
    — confirmed live for AY132, which showed "EnRoute" 12 hours before its
    real departure. Pick whichever candidate's own scheduled departure is
    closest to our stored depart_time instead."""
    if not flights:
        return None
    if len(flights) == 1 or not stored_depart:
        return flights[0]
    try:
        stored_dt = datetime.strptime(str(stored_depart)[:16], "%Y-%m-%dT%H:%M")
    except ValueError:
        return flights[0]

    def _diff(f):
        local = (f.get("departure") or {}).get("scheduledTime", {}).get("local")
        cand = _parse_local_scheduled(local)
        return abs((cand - stored_dt).total_seconds()) if cand else float("inf")

    return min(flights, key=_diff)


def fetch_flight(flight_iata: str, dep_date: str, stored_depart: Optional[str] = None) -> Optional[dict]:
    """Look up a flight by IATA flight number + departure date (YYYY-MM-DD).

    When AeroDataBox returns more than one candidate for that number/date,
    `stored_depart` (the item's own full depart_time, "YYYY-MM-DDTHH:MM")
    disambiguates by picking whichever is scheduled closest to it — see
    _best_match. Returns None when AeroDataBox has no data for that
    flight/date. Raises FlightLiveError on network failure, a non-2xx
    response, or a non-JSON body.
    """
    # Shares RapidAPI's per-second cap with flight_alert_subscriptions.py's
    # webhook calls — same key, same limit (see backend/rate_limit.py).
    throttle("aerodatabox")
    try:
        with httpx.Client(timeout=12) as client:
            r = client.get(
                f"{_AERODATABOX_BASE}/flights/number/{flight_iata}/{dep_date}",
                params={"withLocation": "true"},
                headers={
                    "X-RapidAPI-Key":  AERODATABOX_KEY,
                    "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
                },
            )
    except Exception as e:
        record_external_call("aerodatabox", ok=False, error=str(e))
        raise FlightLiveError(f"Flight API unreachable: {e}")

    # Non-2xx responses (rate limit, auth, quota) often come back as an HTML/
    # plain-text page rather than JSON — parse the body defensively so that
    # case doesn't get misreported as "unreachable" via a JSON-decode error.
    if not r.is_success:
        try:
            err_body = r.json()
            msg = err_body.get("message") or err_body.get("detail") or f"API returned {r.status_code}"
        except ValueError:
            msg = (r.text or "").strip()[:300] or f"API returned {r.status_code} {r.reason_phrase}"
        record_external_call("aerodatabox", ok=False, error=msg)
        raise FlightLiveError(msg)

    try:
        body = r.json()
    except ValueError as e:
        record_external_call("aerodatabox", ok=False, error=str(e))
        raise FlightLiveError(f"AeroDataBox returned an unexpected (non-JSON) response: {e}")
    record_external_call("aerodatabox", ok=True)

    flights = body if isinstance(body, list) else body.get("data", [])
    return _best_match(flights, stored_depart)


def delay_min(movement: dict) -> Optional[int]:
    """Minutes late (+) or early (-) vs the last published schedule, from
    AeroDataBox's scheduledTime vs revisedTime UTC timestamps for this
    movement. None when no revision has been issued (still on schedule)."""
    sched   = (movement.get("scheduledTime") or {}).get("utc")
    revised = (movement.get("revisedTime") or {}).get("utc")
    if not sched or not revised:
        return None
    try:
        fmt = "%Y-%m-%d %H:%M"
        return round((datetime.strptime(revised[:16], fmt) - datetime.strptime(sched[:16], fmt)).total_seconds() / 60)
    except (ValueError, TypeError):
        return None


def delay_str(mins: Optional[int]) -> Optional[str]:
    if mins is None:
        return None
    h, m = divmod(abs(mins), 60)
    dur = (f"{h}h" + (f" {m}m" if m else "")) if h else f"{m}m"
    return f"{dur} early" if mins < 0 else (f"{dur} late" if mins > 0 else "On time")
