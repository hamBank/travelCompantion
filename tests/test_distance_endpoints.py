"""API tests for GET /trips/{id}/distance and GET /me/distance-totals.

D6 (docs/plans/plan-17-travelers.md, plan-17b-personal-totals.md): personal
totals key on being a **traveler** on a trip, not merely a member (owner/
editor/viewer). Auth is disabled in this suite (see tests/conftest.py), so
every request is `dev@local`-as-owner — creating a trip auto-adds a
TripMembership for dev@local (see backend/routers/trips.py) but never a
Traveler row (D1), so `_add_traveler` below must be called explicitly
wherever a trip should count toward dev@local's totals.
"""
from fastapi.testclient import TestClient

DEV_EMAIL = "dev@local"


def _trip_with_stop(client: TestClient):
    trip = client.post("/trips/", json={"name": "Distance Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Anywhere", "status": "planned"
    }).json()
    return trip, stop


def _add_traveler(client: TestClient, trip_id: int, email=DEV_EMAIL, display_name=None):
    r = client.post(f"/trips/{trip_id}/travelers", json={
        "display_name": display_name or email, "user_email": email,
    })
    assert r.status_code == 201, r.text
    return r.json()


def test_trip_distance_empty_trip(client: TestClient):
    trip, _ = _trip_with_stop(client)
    r = client.get(f"/trips/{trip['id']}/distance")
    assert r.status_code == 200
    assert r.json() == {"by_mode": {}, "total_km": 0.0}


def test_trip_distance_sums_by_mode(client: TestClient):
    trip, stop = _trip_with_stop(client)
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "cycling", "name": "Ride", "status": "pending",
        "details": {"gpx_distance_m": 20000},
    })
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "walk", "name": "Hike", "status": "pending",
        "details": {"distance": "5 km"},
    })
    r = client.get(f"/trips/{trip['id']}/distance")
    assert r.status_code == 200
    body = r.json()
    assert body["by_mode"] == {"bike": 20.0, "walking": 5.0}
    assert body["total_km"] == 25.0


def test_trip_distance_404_for_unknown_trip(client: TestClient):
    r = client.get("/trips/999999/distance")
    assert r.status_code == 404


def test_me_distance_totals_empty(client: TestClient):
    r = client.get("/me/distance-totals")
    assert r.status_code == 200
    assert r.json() == {"by_mode": {}, "total_km": 0.0}


def test_me_distance_totals_sums_across_trips(client: TestClient):
    trip1, stop1 = _trip_with_stop(client)
    _add_traveler(client, trip1["id"])
    client.post(f"/stops/{stop1['id']}/items", json={
        "kind": "cycling", "name": "Ride", "status": "pending",
        "details": {"gpx_distance_m": 10000},
    })
    trip2, stop2 = _trip_with_stop(client)
    _add_traveler(client, trip2["id"])
    client.post(f"/stops/{stop2['id']}/items", json={
        "kind": "cycling", "name": "Ride 2", "status": "pending",
        "details": {"gpx_distance_m": 15000},
    })

    r = client.get("/me/distance-totals")
    assert r.status_code == 200
    body = r.json()
    assert body["by_mode"] == {"bike": 25.0}
    assert body["total_km"] == 25.0


# ── D6: totals key on being a traveler, not on membership ──────────────────

def test_owner_not_traveler_excluded_traveler_included(client: TestClient):
    # Trip A: dev@local is owner (auto-membership on create) but never added
    # as a traveler.
    trip_a, stop_a = _trip_with_stop(client)
    client.post(f"/stops/{stop_a['id']}/items", json={
        "kind": "cycling", "name": "Ride A", "status": "pending",
        "details": {"gpx_distance_m": 10000},
    })
    # Trip B: dev@local is both owner and traveler.
    trip_b, stop_b = _trip_with_stop(client)
    _add_traveler(client, trip_b["id"])
    client.post(f"/stops/{stop_b['id']}/items", json={
        "kind": "cycling", "name": "Ride B", "status": "pending",
        "details": {"gpx_distance_m": 4000},
    })

    body = client.get("/me/distance-totals").json()
    assert body["by_mode"] == {"bike": 4.0}   # trip A's distance is excluded

    # Add dev@local as a traveler on A too -> both now count.
    _add_traveler(client, trip_a["id"])
    body = client.get("/me/distance-totals").json()
    assert body["by_mode"] == {"bike": 14.0}

    # Remove the traveler row on A (membership on A is untouched) -> back to B only.
    travelers_a = client.get(f"/trips/{trip_a['id']}/travelers").json()
    traveler_id = next(t["id"] for t in travelers_a if t["user_email"] == DEV_EMAIL)
    assert client.delete(f"/trips/{trip_a['id']}/travelers/{traveler_id}").status_code == 204
    body = client.get("/me/distance-totals").json()
    assert body["by_mode"] == {"bike": 4.0}


def test_non_member_traveler_row_never_contributes(client: TestClient):
    """A Traveler row with no linked account (user_email None — a child, a
    partner without the app) must never match any user's totals."""
    trip, stop = _trip_with_stop(client)
    client.post(f"/trips/{trip['id']}/travelers", json={"display_name": "No Account"})
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "cycling", "name": "Ride", "status": "pending",
        "details": {"gpx_distance_m": 10000},
    })

    body = client.get("/me/distance-totals").json()
    assert body["by_mode"] == {}


def test_traveler_email_case_insensitive_matches_mixed_case_jwt(client: TestClient, session, monkeypatch):
    """Traveler.user_email is stored lowercase (D3); a mixed-case JWT
    identity must still match it."""
    from backend import auth, permissions
    from backend.models import ItineraryItem, Stop, Traveler, Trip

    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)

    trip = Trip(name="Mixed Case Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Anywhere", status="planned")
    session.add(stop)
    session.add(Traveler(trip_id=trip.id, user_email="mixed@example.com", display_name="Mixed"))
    session.commit()
    session.refresh(stop)
    session.add(ItineraryItem(stop_id=stop.id, kind="cycling", name="Ride", status="pending",
                               details={"gpx_distance_m": 10000}))
    session.commit()

    token = auth.create_jwt({"email": "Mixed@Example.com"})
    r = client.get("/me/distance-totals", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["by_mode"] == {"bike": 10.0}
