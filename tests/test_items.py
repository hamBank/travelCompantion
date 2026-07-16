import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def stop(client: TestClient):
    trip = client.post("/trips/", json={"name": "Test Trip"}).json()
    return client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "status": "planned"
    }).json()


def test_create_item(client: TestClient, stop):
    r = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity",
        "name": "Colosseum",
        "status": "pending",
    })
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Colosseum"
    assert data["kind"] == "activity"
    assert data["stop_id"] == stop["id"]


def test_create_item_stop_not_found(client: TestClient):
    r = client.post("/stops/99999/items", json={
        "kind": "activity", "name": "X", "status": "pending"
    })
    assert r.status_code == 404


def test_create_item_all_kinds(client: TestClient, stop):
    for kind in ("activity", "restaurant", "note"):
        r = client.post(f"/stops/{stop['id']}/items", json={
            "kind": kind, "name": f"Test {kind}", "status": "pending"
        })
        assert r.status_code == 201
        assert r.json()["kind"] == kind


def test_list_items(client: TestClient, stop):
    client.post(f"/stops/{stop['id']}/items", json={"kind": "activity", "name": "A", "status": "pending"})
    client.post(f"/stops/{stop['id']}/items", json={"kind": "restaurant", "name": "B", "status": "pending"})
    r = client.get(f"/stops/{stop['id']}/items")
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_get_item(client: TestClient, stop):
    created = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "note", "name": "Pack sunscreen", "status": "pending"
    }).json()
    r = client.get(f"/items/{created['id']}")
    assert r.status_code == 200
    assert r.json()["name"] == "Pack sunscreen"


def test_get_item_not_found(client: TestClient):
    assert client.get("/items/99999").status_code == 404


def test_update_item_status_cycle(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Pantheon", "status": "pending"
    }).json()

    for status in ("done", "skipped", "pending"):
        r = client.patch(f"/items/{item['id']}", json={"status": status})
        assert r.status_code == 200
        assert r.json()["status"] == status


def test_update_item_fields(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Old Name", "status": "pending"
    }).json()
    r = client.patch(f"/items/{item['id']}", json={
        "name": "New Name",
        "link": "https://example.com",
        "cost": "€15",
        "notes": "09:00",
    })
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "New Name"
    assert data["link"] == "https://example.com"
    assert data["cost"] == "€15"
    assert data["notes"] == "09:00"


def test_update_item_kind(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Trattoria Roma", "status": "pending"
    }).json()
    r = client.patch(f"/items/{item['id']}", json={"kind": "restaurant"})
    assert r.status_code == 200
    assert r.json()["kind"] == "restaurant"


def test_delete_item(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "note", "name": "Temp note", "status": "pending"
    }).json()
    r = client.delete(f"/items/{item['id']}")
    assert r.status_code == 204
    assert client.get(f"/items/{item['id']}").status_code == 404


def test_partial_update_preserves_other_fields(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity",
        "name": "Forum",
        "link": "https://example.com",
        "cost": "free",
        "status": "pending",
    }).json()
    client.patch(f"/items/{item['id']}", json={"status": "done"})
    updated = client.get(f"/items/{item['id']}").json()
    assert updated["name"] == "Forum"
    assert updated["link"] == "https://example.com"
    assert updated["cost"] == "free"
    assert updated["status"] == "done"


# ── GET /items/{id}/booking-primary ──────────────────────────────────────────

def test_booking_primary_points_later_leg_to_earlier_one(client: TestClient, stop):
    first = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "CDG → DOH", "status": "pending", "cost": "$2017.50",
        "details": {"booking_ref": "QR/ABC123", "depart_time": "2026-08-19T16:25"},
    }).json()
    second = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "DOH → PER", "status": "pending", "cost": "0",
        "details": {"booking_ref": "QR/ABC123", "depart_time": "2026-08-20T02:30"},
    }).json()

    r = client.get(f"/items/{second['id']}/booking-primary")
    assert r.status_code == 200
    assert r.json() == {"id": first["id"], "name": "CDG → DOH", "cost": "$2017.50"}


def test_booking_primary_is_none_for_the_earliest_leg(client: TestClient, stop):
    first = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "CDG → DOH", "status": "pending", "cost": "$2017.50",
        "details": {"booking_ref": "QR/ABC123", "depart_time": "2026-08-19T16:25"},
    }).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "DOH → PER", "status": "pending", "cost": "0",
        "details": {"booking_ref": "QR/ABC123", "depart_time": "2026-08-20T02:30"},
    })

    r = client.get(f"/items/{first['id']}/booking-primary")
    assert r.status_code == 200
    assert r.json() is None


def test_booking_primary_is_none_without_a_booking_ref(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Solo flight", "status": "pending", "details": {},
    }).json()
    r = client.get(f"/items/{item['id']}/booking-primary")
    assert r.status_code == 200
    assert r.json() is None


def test_booking_primary_is_none_for_non_flight_kinds(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "rail", "name": "Train", "status": "pending",
        "details": {"booking_ref": "SNCF123"},
    }).json()
    r = client.get(f"/items/{item['id']}/booking-primary")
    assert r.status_code == 200
    assert r.json() is None


def test_booking_primary_ignores_other_bookings(client: TestClient, stop):
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Unrelated flight", "status": "pending",
        "details": {"booking_ref": "OTHER999", "depart_time": "2026-08-01T00:00"},
    })
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Only flight in its booking", "status": "pending",
        "details": {"booking_ref": "QR/SOLO", "depart_time": "2026-08-19T16:25"},
    }).json()
    r = client.get(f"/items/{item['id']}/booking-primary")
    assert r.status_code == 200
    assert r.json() is None


# ── POST /river-path ─────────────────────────────────────────────────────────

from backend.routers import items as items_mod


def test_river_path_happy_path(client: TestClient, monkeypatch):
    monkeypatch.setattr(
        items_mod, "estimate_river_path",
        lambda origin, destination, river_name=None: {
            "path": [[45.0, 4.0], [45.1, 4.2]], "distance_km": 12.3, "river_name_used": "Rhône",
        },
    )
    r = client.post("/river-path", json={"points": ["Lyon", "Valence"], "river_name": "Rhône"})
    assert r.status_code == 200
    data = r.json()
    assert data["path"] == [[45.0, 4.0], [45.1, 4.2]]
    assert data["distance_km"] == 12.3
    assert data["river_name_used"] == "Rhône"


def test_river_path_requires_exactly_two_points(client: TestClient):
    r = client.post("/river-path", json={"points": ["Lyon"]})
    assert r.status_code == 400


def test_river_path_400_when_points_too_far_apart(client: TestClient, monkeypatch):
    def raise_too_far(origin, destination, river_name=None):
        raise ValueError("too far apart")
    monkeypatch.setattr(items_mod, "estimate_river_path", raise_too_far)
    r = client.post("/river-path", json={"points": ["A", "B"]})
    assert r.status_code == 400


def test_river_path_404_when_point_cannot_be_geocoded(client: TestClient, monkeypatch):
    def raise_no_path(origin, destination, river_name=None):
        raise items_mod.NoPlausiblePath("Could not resolve 'A' to a location")
    monkeypatch.setattr(items_mod, "estimate_river_path", raise_no_path)
    r = client.post("/river-path", json={"points": ["A", "B"]})
    assert r.status_code == 404
    assert "Could not resolve" in r.json()["detail"]


def test_river_path_200_with_approximate_flag_when_no_waterway_connects(client: TestClient, monkeypatch):
    monkeypatch.setattr(
        items_mod, "estimate_river_path",
        lambda origin, destination, river_name=None: {
            "path": [[45.0, 4.0], [45.5, 4.9]], "distance_km": 55.5,
            "river_name_used": None, "approximate": True,
        },
    )
    r = client.post("/river-path", json={"points": ["A", "B"]})
    assert r.status_code == 200
    data = r.json()
    assert data["approximate"] is True
    assert data["path"] == [[45.0, 4.0], [45.5, 4.9]]


def test_river_path_503_on_lookup_failure(client: TestClient, monkeypatch):
    def raise_error(origin, destination, river_name=None):
        raise RuntimeError("Overpass is down")
    monkeypatch.setattr(items_mod, "estimate_river_path", raise_error)
    r = client.post("/river-path", json={"points": ["A", "B"]})
    assert r.status_code == 503


# ── GET /items/{item_id}/river-map ──────────────────────────────────────────

def test_river_map_404_for_wrong_kind(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Not a river transfer", "status": "pending",
    }).json()
    r = client.get(f"/items/{item['id']}/river-map")
    assert r.status_code == 404


def test_river_map_404_when_no_path_generated(client: TestClient, stop):
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "river_transfer", "name": "Ferry", "status": "pending",
        "details": {"start_location": "Lyon", "end_location": "Valence"},
    }).json()
    r = client.get(f"/items/{item['id']}/river-map")
    assert r.status_code == 404


def test_river_map_503_when_key_not_configured(client: TestClient, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_STATIC_MAPS_KEY", "")
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "river_transfer", "name": "Ferry", "status": "pending",
        "details": {"start_location": "Lyon", "end_location": "Valence",
                    "river_path": [[45.0, 4.0], [45.1, 4.2]]},
    }).json()
    r = client.get(f"/items/{item['id']}/river-map")
    assert r.status_code == 503


def test_river_map_happy_path(client: TestClient, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_STATIC_MAPS_KEY", "test-key")
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "river_transfer", "name": "Ferry", "status": "pending",
        "details": {"start_location": "Lyon", "end_location": "Valence",
                    "river_path": [[45.0, 4.0], [45.1, 4.2]]},
    }).json()

    fake_png = b"\x89PNG\r\n\x1a\nfakebytes"

    class FakeResponse:
        content = fake_png
        def raise_for_status(self):
            pass

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url):
            assert "maps.googleapis.com/maps/api/staticmap" in url
            assert "key=test-key" in url
            return FakeResponse()

    monkeypatch.setattr(items_mod.httpx, "Client", FakeClient)

    r = client.get(f"/items/{item['id']}/river-map")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content == fake_png
    assert "ETag" in r.headers
    assert "max-age" in r.headers["cache-control"]


# ── GET /stops/{id}/day-map ──────────────────────────────────────────────────

def test_day_map_400_with_no_locations(client: TestClient, stop):
    r = client.get(f"/stops/{stop['id']}/day-map", params={"locations": ["", "   "]})
    assert r.status_code == 400


def test_day_map_400_with_too_many_locations(client: TestClient, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_STATIC_MAPS_KEY", "test-key")
    locs = [f"Place {i}" for i in range(items_mod._DAY_MAP_MAX_LOCATIONS + 1)]
    r = client.get(f"/stops/{stop['id']}/day-map", params={"locations": locs})
    assert r.status_code == 400


def test_day_map_503_when_key_not_configured(client: TestClient, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_STATIC_MAPS_KEY", "")
    r = client.get(f"/stops/{stop['id']}/day-map", params={"locations": ["Rome"]})
    assert r.status_code == 503


def test_day_map_404_for_missing_stop(client: TestClient):
    r = client.get("/stops/999999/day-map", params={"locations": ["Rome"]})
    assert r.status_code == 404


def test_day_map_happy_path_dedupes_and_labels_markers(client: TestClient, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_STATIC_MAPS_KEY", "test-key")
    fake_png = b"\x89PNG\r\n\x1a\nfakebytes"

    class FakeResponse:
        content = fake_png
        def raise_for_status(self):
            pass

    captured = {}

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url):
            captured["url"] = url
            assert "maps.googleapis.com/maps/api/staticmap" in url
            assert "key=test-key" in url
            return FakeResponse()

    monkeypatch.setattr(items_mod.httpx, "Client", FakeClient)

    r = client.get(f"/stops/{stop['id']}/day-map", params={
        "locations": ["Colosseum, Rome", "colosseum, rome", "Trevi Fountain, Rome"],
    })
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content == fake_png
    assert "ETag" in r.headers
    # Deduplicated case-insensitively: only 2 distinct markers, labeled A/B.
    assert captured["url"].count("markers=") == 2
    assert "label%3AA" in captured["url"] or "label:A" in captured["url"]
    assert "label%3AB" in captured["url"] or "label:B" in captured["url"]
