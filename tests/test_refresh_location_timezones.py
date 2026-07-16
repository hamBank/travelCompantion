from sqlmodel import Session, select

from backend.models import ItineraryItem, LocationTimezone, Stop, Trip
from scripts.refresh_location_timezones import pending_locations, refresh_all


def _stop_id(session: Session, location: str = "", **kwargs) -> int:
    """Real Trip + Stop rows, not just a hardcoded id — Postgres CI enforces
    the FK that SQLite silently lets slide. Defaults location to "" (excluded
    by pending_locations' `if loc:` check) so flight-only tests don't
    accidentally pull the stop's own location into their expected sets."""
    trip = Trip(name="Test Trip")
    session.add(trip)
    session.commit()
    stop = Stop(trip_id=trip.id, status="planned", location=location, **kwargs)
    session.add(stop)
    session.commit()
    return stop.id


def _flight(stop_id, origin, destination, details=None):
    d = {"origin": origin, "destination": destination, **(details or {})}
    return ItineraryItem(stop_id=stop_id, kind="flight", name=f"{origin}→{destination}", status="pending", details=d)


def test_pending_locations_collects_distinct_origins_and_destinations(session: Session):
    sid = _stop_id(session)
    session.add(_flight(sid, "FCO", "ZRH"))
    session.add(_flight(sid, "BDS", "FCO"))
    session.commit()
    assert pending_locations(session) == {"FCO", "ZRH", "BDS"}


def test_pending_locations_excludes_already_cached(session: Session):
    sid = _stop_id(session)
    session.add(_flight(sid, "FCO", "ZRH"))
    session.add(LocationTimezone(location="FCO", iana_zone="Europe/Rome"))
    session.commit()
    assert pending_locations(session) == {"ZRH"}


def test_pending_locations_ignores_non_flight_items(session: Session):
    sid = _stop_id(session)
    session.add(ItineraryItem(stop_id=sid, kind="activity", name="Museum", status="pending",
                               details={"location": "Rome"}))
    session.commit()
    assert pending_locations(session) == set()


def test_pending_locations_includes_stop_locations_regardless_of_timezone_set(session: Session):
    _stop_id(session, location="Nice")  # timezone left at default "0"
    _stop_id(session, location="Turin", timezone="2")
    assert pending_locations(session) == {"Nice", "Turin"}


def test_pending_locations_excludes_already_cached_stop_location(session: Session):
    _stop_id(session, location="Nice")
    session.add(LocationTimezone(location="Nice", iana_zone="Europe/Paris"))
    session.commit()
    assert pending_locations(session) == set()


def test_refresh_all_resolves_and_caches_pending_locations(session: Session):
    sid = _stop_id(session)
    session.add(_flight(sid, "FCO", "ZRH"))
    session.commit()

    # Encode identity in the fake coords so fetch_json can recover which
    # airport it's answering for regardless of set-iteration order.
    coords = {"FCO": (1.0, 1.0), "ZRH": (2.0, 2.0)}
    zones_by_coords = {(1.0, 1.0): "Europe/Rome", (2.0, 2.0): "Europe/Zurich"}

    def fake_geocode(q):
        code = q.split()[0]
        return coords.get(code)

    def fake_fetch_json(url):
        for (lat, lng), zone in zones_by_coords.items():
            if f"latitude={lat}" in url and f"longitude={lng}" in url:
                return {"timezone": zone}
        return {}

    n = refresh_all(session, geocode=fake_geocode, fetch_json=fake_fetch_json)
    assert n == 2
    rows = {r.location: r.iana_zone for r in session.exec(select(LocationTimezone)).all()}
    assert rows == {"FCO": "Europe/Rome", "ZRH": "Europe/Zurich"}


def test_refresh_all_skips_unresolvable_locations_without_erroring(session: Session):
    sid = _stop_id(session)
    session.add(_flight(sid, "XXX", "ZRH"))
    session.commit()

    def fake_geocode(q):
        return None if q.startswith("XXX") else (0.0, 0.0)

    def fake_fetch_json(url):
        return {"timezone": "Europe/Zurich"}

    n = refresh_all(session, geocode=fake_geocode, fetch_json=fake_fetch_json)
    assert n == 1
    rows = {r.location for r in session.exec(select(LocationTimezone)).all()}
    assert rows == {"ZRH"}
