"""Tests for GET /me/travel-totals (plan 17b: personal cross-trip totals —
trips/days/countries/distance — all keyed on being a **traveler** on a trip,
D6, docs/plans/plan-17-travelers.md). Auth is disabled in this suite (see
tests/conftest.py), so every request is dev@local-as-owner; a trip only
counts once dev@local is explicitly added as a traveler on it (D1 — creating
a trip does not auto-add you as a traveler)."""
from fastapi.testclient import TestClient

DEV_EMAIL = "dev@local"


def _add_traveler(client: TestClient, trip_id: int, email=DEV_EMAIL, display_name=None):
    r = client.post(f"/trips/{trip_id}/travelers", json={
        "display_name": display_name or email, "user_email": email,
    })
    assert r.status_code == 201, r.text
    return r.json()


def test_me_travel_totals_empty(client: TestClient):
    r = client.get("/me/travel-totals")
    assert r.status_code == 200
    assert r.json() == {
        "trips": 0, "days": 0, "countries": [],
        "distance": {"by_mode": {}, "total_km": 0.0},
    }


def test_me_travel_totals_trips_only_counts_trips_traveled_on(client: TestClient):
    trip_a = client.post("/trips/", json={"name": "Owner Only"}).json()   # not a traveler
    trip_b = client.post("/trips/", json={"name": "Traveling"}).json()
    _add_traveler(client, trip_b["id"])

    body = client.get("/me/travel-totals").json()
    assert body["trips"] == 1


def test_me_travel_totals_days_sums_dated_trip_span_undated_contributes_zero(client: TestClient):
    # A 3-day dated trip (Jan 1 -> Jan 3 inclusive == 3 days).
    dated = client.post("/trips/", json={
        "name": "Dated Trip",
        "start_date": "2026-01-01T00:00:00",
        "end_date": "2026-01-03T00:00:00",
    }).json()
    _add_traveler(client, dated["id"])

    # An undated trip with no dated stops/items either -> contributes 0 days.
    undated = client.post("/trips/", json={"name": "Undated Trip"}).json()
    _add_traveler(client, undated["id"])
    client.post(f"/trips/{undated['id']}/stops", json={"location": "Nowhere", "status": "planned"})

    body = client.get("/me/travel-totals").json()
    assert body["trips"] == 2
    assert body["days"] == 3


def test_me_travel_totals_countries_sorted_unique_non_empty(client: TestClient):
    trip1 = client.post("/trips/", json={"name": "Trip 1"}).json()
    _add_traveler(client, trip1["id"])
    client.post(f"/trips/{trip1['id']}/stops", json={"location": "Paris", "country": "FR", "status": "planned"})
    client.post(f"/trips/{trip1['id']}/stops", json={"location": "Lyon", "country": "FR", "status": "planned"})
    # A stop with no country recorded — must be excluded, not turned into "".
    client.post(f"/trips/{trip1['id']}/stops", json={"location": "Somewhere", "status": "planned"})

    trip2 = client.post("/trips/", json={"name": "Trip 2"}).json()
    _add_traveler(client, trip2["id"])
    client.post(f"/trips/{trip2['id']}/stops", json={"location": "Tokyo", "country": "JP", "status": "planned"})

    body = client.get("/me/travel-totals").json()
    assert body["countries"] == ["FR", "JP"]


def test_me_travel_totals_distance_matches_distance_totals_endpoint(client: TestClient):
    trip, stop_a = None, None
    trip = client.post("/trips/", json={"name": "Distance Trip"}).json()
    _add_traveler(client, trip["id"])
    stop = client.post(f"/trips/{trip['id']}/stops", json={"location": "Anywhere", "status": "planned"}).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "cycling", "name": "Ride", "status": "pending",
        "details": {"gpx_distance_m": 12000},
    })

    totals_body = client.get("/me/travel-totals").json()
    distance_body = client.get("/me/distance-totals").json()
    assert totals_body["distance"] == distance_body


def test_me_travel_totals_owner_without_traveler_row_contributes_nothing(client: TestClient):
    trip = client.post("/trips/", json={"name": "Not Traveling"}).json()
    client.post(f"/trips/{trip['id']}/stops", json={"location": "Paris", "country": "FR", "status": "planned"})

    body = client.get("/me/travel-totals").json()
    assert body == {
        "trips": 0, "days": 0, "countries": [],
        "distance": {"by_mode": {}, "total_km": 0.0},
    }
