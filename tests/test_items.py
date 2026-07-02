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


def test_river_path_404_when_no_plausible_path(client: TestClient, monkeypatch):
    def raise_no_path(origin, destination, river_name=None):
        raise items_mod.NoPlausiblePath("no waterway data found")
    monkeypatch.setattr(items_mod, "estimate_river_path", raise_no_path)
    r = client.post("/river-path", json={"points": ["A", "B"]})
    assert r.status_code == 404
    assert "no waterway data found" in r.json()["detail"]


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
