"""API tests for GET /trips/{id}/distance and GET /me/distance-totals."""
from fastapi.testclient import TestClient


def _trip_with_stop(client: TestClient):
    trip = client.post("/trips/", json={"name": "Distance Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Anywhere", "status": "planned"
    }).json()
    return trip, stop


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
    client.post(f"/stops/{stop1['id']}/items", json={
        "kind": "cycling", "name": "Ride", "status": "pending",
        "details": {"gpx_distance_m": 10000},
    })
    trip2, stop2 = _trip_with_stop(client)
    client.post(f"/stops/{stop2['id']}/items", json={
        "kind": "cycling", "name": "Ride 2", "status": "pending",
        "details": {"gpx_distance_m": 15000},
    })

    r = client.get("/me/distance-totals")
    assert r.status_code == 200
    body = r.json()
    assert body["by_mode"] == {"bike": 25.0}
    assert body["total_km"] == 25.0
