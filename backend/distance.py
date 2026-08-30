"""Distance traveled per trip, broken down by transport mode, and running
per-user totals across trips.

Each item kind has a different "best available" source of truth for its
distance, tried in order of accuracy — a real GPS track beats a road-routed
estimate beats a straight-line geocoded guess:

* cycling/walk: `details.gpx_distance_m` (an uploaded/generated GPX track) →
  `details.distance` (free text, e.g. "12 km" — often itself derived from
  Google's road-routed Directions API via the DistanceButton/route-to-gpx
  flow in routers/items.py, so still meaningfully better than a straight line).
* river_transfer: summed haversine over `details.river_path` (a real stitched
  river-geometry polyline from river_path.py) → `details.distance` text.
* rail/transfer/hire: `details.distance` text → straight-line haversine
  between geocoded origin/destination (only fallback available — none of
  these kinds store a route today).
* flight: straight-line haversine between the two airports' real coordinates
  (IATA→lat/lng via flight_alert_subscriptions.airport_location) — no
  `distance` field exists on flight items, and a great-circle distance is
  actually a good match for how flights fly, unlike ground transport.

Geocoding/airport lookups are resolved live on first use and cached
permanently in LocationCoords — NEVER wired into a cron (see CLAUDE.md's
"Metered external APIs" note: a cron-driven unconditional external call is
exactly the mistake that exhausted AeroDataBox's quota once already). This
module is only ever invoked on demand, when a user actually asks to see a
distance total.
"""
import re
from datetime import datetime
from math import asin, cos, radians, sin, sqrt
from typing import Optional

from sqlmodel import Session, select

from .models import ItineraryItem, LocationCoords, Stop, TripMembership, UserDistanceTotal
from .weather import geocode as _geocode_place

# ItemKind → transport mode bucket. Kinds not listed here (accommodation,
# activity, note, etc.) simply aren't distance-bearing and are skipped.
TRANSPORT_MODE = {
    "flight": "air",
    "rail": "rail",
    "transfer": "road",
    "hire": "road",
    "river_transfer": "boat",
    "cycling": "bike",
    "walk": "walking",
}

_IATA_RE = re.compile(r"^[A-Z]{3}$")
_MI_TO_KM = 1.609344
_EARTH_RADIUS_KM = 6371.0088

# "12 km", "45km", "~9.5 km", "5,759 mi", "5,759 miles" — same free-text
# convention the distance field already uses across every form that has one.
_DISTANCE_RE = re.compile(r"([\d,]+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|mi|miles?)\b", re.IGNORECASE)


def parse_distance_km(text) -> Optional[float]:
    if not text:
        return None
    m = _DISTANCE_RE.search(str(text))
    if not m:
        return None
    try:
        value = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return value * _MI_TO_KM if m.group(2).lower().startswith("mi") else value


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    phi1, phi2 = radians(lat1), radians(lat2)
    dphi = radians(lat2 - lat1)
    dlambda = radians(lng2 - lng1)
    a = sin(dphi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(dlambda / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * asin(sqrt(a))


def _river_path_km(points) -> Optional[float]:
    if not points or len(points) < 2:
        return None
    total = 0.0
    for (lat1, lng1), (lat2, lng2) in zip(points, points[1:]):
        total += haversine_km(lat1, lng1, lat2, lng2)
    return total


def resolve_coords(session: Session, location: str, *, geocode=_geocode_place,
                    airport_request=None) -> Optional[tuple]:
    """location → (lat, lng), cached permanently in LocationCoords. A bare
    3-letter uppercase code is treated as an IATA airport code and resolved
    via the AeroDataBox airport lookup (exact); anything else is geocoded via
    Nominatim (approximate — a city/station name, not the actual road/rail
    endpoint). A location that fails to resolve is NOT cached, so a fixable
    typo gets another chance on the next computation rather than being
    permanently remembered as unresolvable.
    """
    loc = (location or "").strip()
    if not loc:
        return None
    key = loc.upper() if _IATA_RE.match(loc.upper()) else loc
    row = session.get(LocationCoords, key)
    if row:
        return (row.lat, row.lng)

    if _IATA_RE.match(key):
        from . import flight_alert_subscriptions as fas
        kwargs = {"request": airport_request} if airport_request is not None else {}
        coords = fas.airport_location(key, **kwargs)
    else:
        coords = geocode(loc)

    if not coords:
        return None
    session.add(LocationCoords(location=key, lat=coords[0], lng=coords[1]))
    session.commit()
    return (coords[0], coords[1])


def _geocoded_distance(session, origin, dest, geocode, airport_request) -> Optional[float]:
    if not origin or not dest:
        return None
    c1 = resolve_coords(session, origin, geocode=geocode, airport_request=airport_request)
    c2 = resolve_coords(session, dest, geocode=geocode, airport_request=airport_request)
    if not c1 or not c2:
        return None
    return haversine_km(c1[0], c1[1], c2[0], c2[1])


def item_distance_km(session: Session, item: ItineraryItem, *, geocode=_geocode_place,
                      airport_request=None) -> Optional[float]:
    """Best-effort distance for one item, in km — None when nothing usable is
    stored (never guessed)."""
    d = item.details or {}
    kind = item.kind.value if hasattr(item.kind, "value") else item.kind

    if kind in ("cycling", "walk"):
        gpx_m = d.get("gpx_distance_m")
        if gpx_m:
            return gpx_m / 1000.0
        return parse_distance_km(d.get("distance"))

    if kind == "river_transfer":
        km = _river_path_km(d.get("river_path"))
        if km is not None:
            return km
        return parse_distance_km(d.get("distance"))

    if kind == "flight":
        return _geocoded_distance(session, d.get("origin"), d.get("destination"), geocode, airport_request)

    if kind == "rail":
        text = parse_distance_km(d.get("distance"))
        if text is not None:
            return text
        return _geocoded_distance(session, d.get("origin"), d.get("destination"), geocode, None)

    if kind == "transfer":
        text = parse_distance_km(d.get("distance"))
        if text is not None:
            return text
        return _geocoded_distance(session, d.get("start_location"), d.get("end_location"), geocode, None)

    if kind == "hire":
        text = parse_distance_km(d.get("distance"))
        if text is not None:
            return text
        return _geocoded_distance(session, d.get("pickup_location"), d.get("dropoff_location"), geocode, None)

    return None


def compute_trip_distances(session: Session, trip_id: int, *, geocode=_geocode_place,
                            airport_request=None) -> dict:
    """{mode: total_km} for one trip. Modes with nothing computable are simply
    absent (not zero) — callers distinguish "no data" from "genuinely 0km"."""
    stop_ids = session.exec(select(Stop.id).where(Stop.trip_id == trip_id)).all()
    if not stop_ids:
        return {}
    items = session.exec(
        select(ItineraryItem).where(ItineraryItem.stop_id.in_(stop_ids))
    ).all()

    totals: dict = {}
    for item in items:
        kind = item.kind.value if hasattr(item.kind, "value") else item.kind
        mode = TRANSPORT_MODE.get(kind)
        if not mode:
            continue
        km = item_distance_km(session, item, geocode=geocode, airport_request=airport_request)
        if km:
            totals[mode] = totals.get(mode, 0.0) + km
    return totals


def compute_user_distance_totals(session: Session, user_email: str, *, geocode=_geocode_place,
                                  airport_request=None) -> dict:
    """Recomputes {mode: total_km} from scratch across every trip
    `user_email` belongs to (any role), and upserts the result into
    UserDistanceTotal — a cache of this computation, not an incrementally
    maintained ledger, so a deleted trip or edited item is correctly
    reflected on the very next call with no special-casing at any write site.
    """
    email = user_email.lower()
    trip_ids = set(session.exec(
        select(TripMembership.trip_id).where(TripMembership.user_email == email)
    ).all())

    grand: dict = {}
    for trip_id in trip_ids:
        for mode, km in compute_trip_distances(session, trip_id, geocode=geocode,
                                                 airport_request=airport_request).items():
            grand[mode] = grand.get(mode, 0.0) + km

    now = datetime.utcnow()
    existing = {
        row.mode: row for row in session.exec(
            select(UserDistanceTotal).where(UserDistanceTotal.user_email == email)
        ).all()
    }
    for mode, km in grand.items():
        row = existing.pop(mode, None)
        if row:
            row.total_km = km
            row.updated_at = now
        else:
            row = UserDistanceTotal(user_email=email, mode=mode, total_km=km, updated_at=now)
        session.add(row)
    # A mode with no more distance-bearing items this pass (last flight
    # deleted, trip removed, etc.) — zero it out rather than leaving a stale row.
    for row in existing.values():
        row.total_km = 0.0
        row.updated_at = now
        session.add(row)
    session.commit()
    return grand
