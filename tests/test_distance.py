"""Tests for backend/distance.py — per-item, per-trip, and per-user distance
totals broken down by transport mode."""
from sqlmodel import Session, select

from backend import distance as dist
from backend.models import (
    ItineraryItem, LocationCoords, Stop, Trip, TripMembership, UserDistanceTotal,
)


def _trip_stop(session: Session, member_email="a@x.com") -> tuple:
    trip = Trip(name="Test Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Anywhere", status="planned")
    session.add(stop)
    session.add(TripMembership(trip_id=trip.id, user_email=member_email, role="owner"))
    session.commit()
    session.refresh(stop)
    return trip, stop


def _item(session: Session, stop_id: int, kind: str, details: dict) -> ItineraryItem:
    item = ItineraryItem(stop_id=stop_id, kind=kind, name=kind, status="pending", details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


# ── parse_distance_km ─────────────────────────────────────────────────────────

def test_parses_plain_km():
    assert dist.parse_distance_km("12 km") == 12.0


def test_parses_km_no_space():
    assert dist.parse_distance_km("45km") == 45.0


def test_parses_tilde_estimate():
    assert dist.parse_distance_km("~9.5 km") == 9.5


def test_parses_miles_with_thousands_separator():
    assert round(dist.parse_distance_km("5,759 mi"), 2) == round(5759 * 1.609344, 2)


def test_parses_miles_word():
    assert round(dist.parse_distance_km("10 miles"), 4) == round(10 * 1.609344, 4)


def test_returns_none_for_empty_or_unparseable():
    assert dist.parse_distance_km("") is None
    assert dist.parse_distance_km(None) is None
    assert dist.parse_distance_km("somewhere nice") is None


# ── haversine_km ─────────────────────────────────────────────────────────────

def test_haversine_zero_for_same_point():
    assert dist.haversine_km(41.9, 12.5, 41.9, 12.5) == 0.0


def test_haversine_known_distance_rome_to_paris():
    # Rome (41.9, 12.5) to Paris (48.86, 2.35) — real great-circle distance ~1105km
    km = dist.haversine_km(41.9, 12.5, 48.86, 2.35)
    assert 1080 < km < 1130


# ── resolve_coords ────────────────────────────────────────────────────────────

def test_resolve_coords_geocodes_place_name_and_caches(session: Session):
    calls = []
    def fake_geocode(q):
        calls.append(q)
        return (41.9, 12.5)
    assert dist.resolve_coords(session, "Rome", geocode=fake_geocode) == (41.9, 12.5)
    assert calls == ["Rome"]
    # Second call hits the cache, not geocode again.
    assert dist.resolve_coords(session, "Rome", geocode=fake_geocode) == (41.9, 12.5)
    assert calls == ["Rome"]


def test_resolve_coords_routes_iata_code_to_airport_lookup(session: Session):
    def fake_airport_request(method, path, json_body=None):
        assert path == "/airports/Iata/FCO"
        class R:
            def json(self):
                return {"location": {"lat": 41.8, "lon": 12.25}}
        return R()
    coords = dist.resolve_coords(session, "FCO", geocode=lambda q: (0, 0), airport_request=fake_airport_request)
    assert coords == (41.8, 12.25)


def test_resolve_coords_none_when_unresolvable_and_not_cached(session: Session):
    assert dist.resolve_coords(session, "Nowhereville", geocode=lambda q: None) is None
    assert session.get(LocationCoords, "Nowhereville") is None


# ── item_distance_km ──────────────────────────────────────────────────────────

def test_cycling_prefers_gpx_distance_over_text(session: Session):
    item = ItineraryItem(stop_id=1, kind="cycling", name="Ride",
                         details={"gpx_distance_m": 42000, "distance": "10 km"})
    assert dist.item_distance_km(session, item) == 42.0


def test_cycling_falls_back_to_distance_text(session: Session):
    item = ItineraryItem(stop_id=1, kind="cycling", name="Ride", details={"distance": "42 km"})
    assert dist.item_distance_km(session, item) == 42.0


def test_walk_same_as_cycling(session: Session):
    item = ItineraryItem(stop_id=1, kind="walk", name="Hike", details={"gpx_distance_m": 5000})
    assert dist.item_distance_km(session, item) == 5.0


def test_river_transfer_sums_river_path_points(session: Session):
    # Three colinear-ish points; exact sum doesn't matter, just that it's the
    # sum of hops, not point-to-point.
    path = [[45.0, 4.8], [44.5, 4.8], [44.0, 4.8]]
    item = ItineraryItem(stop_id=1, kind="river_transfer", name="Boat", details={"river_path": path})
    expected = dist.haversine_km(45.0, 4.8, 44.5, 4.8) + dist.haversine_km(44.5, 4.8, 44.0, 4.8)
    assert round(dist.item_distance_km(session, item), 4) == round(expected, 4)


def test_river_transfer_falls_back_to_distance_text_without_path(session: Session):
    item = ItineraryItem(stop_id=1, kind="river_transfer", name="Boat", details={"distance": "120 km"})
    assert dist.item_distance_km(session, item) == 120.0


def test_flight_uses_airport_coords(session: Session):
    def fake_airport_request(method, path, json_body=None):
        coords = {"FCO": (41.8, 12.25), "ZRH": (47.45, 8.56)}[path.rsplit("/", 1)[1]]
        class R:
            def json(self):
                return {"location": {"lat": coords[0], "lon": coords[1]}}
        return R()
    item = ItineraryItem(stop_id=1, kind="flight", name="Flight",
                         details={"origin": "FCO", "destination": "ZRH"})
    km = dist.item_distance_km(session, item, airport_request=fake_airport_request)
    assert km is not None and km > 0


def test_flight_none_without_both_endpoints(session: Session):
    item = ItineraryItem(stop_id=1, kind="flight", name="Flight", details={"origin": "FCO"})
    assert dist.item_distance_km(session, item) is None


def test_rail_prefers_text_over_geocoding(session: Session):
    def fake_geocode(q):
        raise AssertionError("should not geocode when distance text is present")
    item = ItineraryItem(stop_id=1, kind="rail", name="Train",
                         details={"origin": "A", "destination": "B", "distance": "300 km"})
    assert dist.item_distance_km(session, item, geocode=fake_geocode) == 300.0


def test_rail_geocodes_when_no_text(session: Session):
    def fake_geocode(q):
        return {"A": (48.0, 2.0), "B": (52.0, 13.0)}[q]
    item = ItineraryItem(stop_id=1, kind="rail", name="Train", details={"origin": "A", "destination": "B"})
    km = dist.item_distance_km(session, item, geocode=fake_geocode)
    assert km is not None and km > 0


def test_transfer_prefers_text_then_geocodes(session: Session):
    item = ItineraryItem(stop_id=1, kind="transfer", name="Car", details={"distance": "15 km"})
    assert dist.item_distance_km(session, item) == 15.0


def test_hire_uses_pickup_dropoff_fields(session: Session):
    def fake_geocode(q):
        return {"Depot A": (10.0, 10.0), "Depot B": (10.1, 10.1)}[q]
    item = ItineraryItem(stop_id=1, kind="hire", name="Car hire",
                         details={"pickup_location": "Depot A", "dropoff_location": "Depot B"})
    km = dist.item_distance_km(session, item, geocode=fake_geocode)
    assert km is not None and km > 0


def test_non_transport_kind_returns_none(session: Session):
    item = ItineraryItem(stop_id=1, kind="activity", name="Museum", details={})
    assert dist.item_distance_km(session, item) is None


def test_empty_details_returns_none(session: Session):
    item = ItineraryItem(stop_id=1, kind="transfer", name="Car", details=None)
    assert dist.item_distance_km(session, item) is None


# ── compute_trip_distances ────────────────────────────────────────────────────

def test_compute_trip_distances_groups_by_mode(session: Session):
    _, stop = _trip_stop(session)
    _item(session, stop.id, "cycling", {"gpx_distance_m": 10000})
    _item(session, stop.id, "cycling", {"gpx_distance_m": 5000})
    _item(session, stop.id, "walk", {"distance": "2 km"})
    _item(session, stop.id, "activity", {})  # not distance-bearing — ignored

    totals = dist.compute_trip_distances(session, stop.trip_id)
    assert totals == {"bike": 15.0, "walking": 2.0}


def test_compute_trip_distances_empty_trip_returns_empty_dict(session: Session):
    trip = Trip(name="Empty")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    assert dist.compute_trip_distances(session, trip.id) == {}


def test_compute_trip_distances_skips_unresolvable_items_silently(session: Session):
    _, stop = _trip_stop(session)
    _item(session, stop.id, "rail", {"origin": "A", "destination": "B"})  # no distance, no geocode possible
    assert dist.compute_trip_distances(session, stop.trip_id, geocode=lambda q: None) == {}


# ── compute_user_distance_totals ──────────────────────────────────────────────

def test_compute_user_distance_totals_sums_across_trips(session: Session):
    _, stop1 = _trip_stop(session, member_email="me@x.com")
    _item(session, stop1.id, "cycling", {"gpx_distance_m": 10000})

    trip2 = Trip(name="Trip 2")
    session.add(trip2)
    session.commit()
    session.refresh(trip2)
    stop2 = Stop(trip_id=trip2.id, location="Elsewhere", status="planned")
    session.add(stop2)
    session.add(TripMembership(trip_id=trip2.id, user_email="me@x.com", role="editor"))
    session.commit()
    session.refresh(stop2)
    _item(session, stop2.id, "cycling", {"gpx_distance_m": 5000})

    totals = dist.compute_user_distance_totals(session, "me@x.com")
    assert totals == {"bike": 15.0}

    rows = session.exec(select(UserDistanceTotal).where(UserDistanceTotal.user_email == "me@x.com")).all()
    assert len(rows) == 1
    assert rows[0].total_km == 15.0


def test_compute_user_distance_totals_ignores_other_users_trips(session: Session):
    _, stop = _trip_stop(session, member_email="them@x.com")
    _item(session, stop.id, "cycling", {"gpx_distance_m": 10000})
    assert dist.compute_user_distance_totals(session, "me@x.com") == {}


def test_compute_user_distance_totals_zeroes_out_stale_mode(session: Session):
    _, stop = _trip_stop(session, member_email="me@x.com")
    item = _item(session, stop.id, "cycling", {"gpx_distance_m": 10000})
    dist.compute_user_distance_totals(session, "me@x.com")

    # Item edited to no longer be distance-bearing.
    item.details = {}
    session.add(item)
    session.commit()

    dist.compute_user_distance_totals(session, "me@x.com")
    row = session.get(UserDistanceTotal, ("me@x.com", "bike"))
    assert row.total_km == 0.0


def test_compute_user_distance_totals_case_insensitive_email(session: Session):
    _, stop = _trip_stop(session, member_email="me@x.com")
    _item(session, stop.id, "cycling", {"gpx_distance_m": 10000})
    totals = dist.compute_user_distance_totals(session, "ME@X.COM")
    assert totals == {"bike": 10.0}
