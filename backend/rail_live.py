"""Live rail lookups via the DB (Deutsche Bahn) transport.rest REST API.

Mirrors backend/flight_live.py's shape (fetch function + error type + delay
helpers) so the notifications cron (backend/notifications.py) can poll rail
departures the same way it polls flights. The station-lookup + departures
dance and the two-host fallback are the same ones backend/routers/items.py's
check_rail endpoint uses for its manual per-item check — duplicated here
(rather than shared) since that endpoint also renders a field-by-field
comparison UI this module has no need for.

Unlike AeroDataBox, transport.rest is a free, unauthenticated public API with
no published metered quota — see the RAIL_ALERT_* defaults in
notifications.py, which are looser than the flight alert's for that reason,
but still bounded so a misbehaving cron doesn't hammer someone else's free
infrastructure every tick.
"""
from datetime import datetime
from typing import Optional
import httpx

from .metrics import record_external_call

_DB_REST_HOSTS = ["https://v6.db.transport.rest", "https://v5.db.transport.rest"]
_DB_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "application/json",
}


class RailLiveError(Exception):
    """Raised when every mirror host is unreachable or returns a non-2xx/
    non-JSON response. str(e) is a caller-facing detail message."""


def fetch_rail(train_number: str, origin_name: str, dep_time: Optional[str] = None) -> Optional[dict]:
    """Look up a train's live departure by train number + origin station name.

    Returns the matching departure dict from the DB REST API (fields include
    `when`/`plannedWhen`, `platform`/`plannedPlatform`, `cancelled`), or None
    when the station can't be resolved or the train isn't in that station's
    departure board. Raises RailLiveError when every mirror host fails.
    """
    train_key = train_number.replace(" ", "").upper()
    dep_params: dict = {"results": 30, "duration": 20, "language": "en", "stopovers": "false"}
    if dep_time:
        dep_params["when"] = dep_time

    last_error = "Rail API unreachable"
    with httpx.Client(timeout=14, headers=_DB_HEADERS) as client:
        for host in _DB_REST_HOSTS:
            try:
                loc_r = client.get(f"{host}/locations", params={
                    "query": origin_name, "results": 3, "stops": "true", "language": "en",
                })
                if loc_r.status_code == 503 or not loc_r.is_success or not loc_r.text:
                    last_error = f"Station lookup failed ({loc_r.status_code})"
                    record_external_call("db_transport_rest", ok=False, error=last_error)
                    continue
                record_external_call("db_transport_rest", ok=True)
                locations = loc_r.json()
                if not locations:
                    return None

                stop_id = locations[0]["id"]
                dep_r = client.get(f"{host}/stops/{stop_id}/departures", params=dep_params)
                if not dep_r.is_success or not dep_r.text:
                    last_error = f"Departures failed ({dep_r.status_code})"
                    record_external_call("db_transport_rest", ok=False, error=last_error)
                    continue
                record_external_call("db_transport_rest", ok=True)

                dep_body = dep_r.json()
                departures = dep_body.get("departures", dep_body) if isinstance(dep_body, dict) else dep_body
                if not isinstance(departures, list):
                    departures = []
                for dep in departures:
                    line_name = (dep.get("line") or {}).get("name") or ""
                    if line_name.replace(" ", "").upper() == train_key:
                        return dep
                return None  # station + API reachable, train just not on this board

            except Exception as e:
                last_error = str(e)
                record_external_call("db_transport_rest", ok=False, error=last_error)
                continue

    raise RailLiveError(last_error)


def delay_min(dep: dict) -> Optional[int]:
    """Minutes late (+) vs schedule, from `when` vs `plannedWhen` (both
    ISO-8601 with UTC offset) — matching flight_live.delay_min's timestamp-
    diff approach rather than trusting the API's own `delay` field, whose
    unit isn't documented. None when either timestamp is missing (e.g. a
    cancelled departure, where `when` goes null)."""
    planned = dep.get("plannedWhen")
    when = dep.get("when")
    if not planned or not when:
        return None
    try:
        return round((datetime.fromisoformat(when) - datetime.fromisoformat(planned)).total_seconds() / 60)
    except (ValueError, TypeError):
        return None


def delay_str(mins: Optional[int]) -> Optional[str]:
    if mins is None:
        return None
    h, m = divmod(abs(mins), 60)
    dur = (f"{h}h" + (f" {m}m" if m else "")) if h else f"{m}m"
    return f"{dur} early" if mins < 0 else (f"{dur} late" if mins > 0 else "On time")
