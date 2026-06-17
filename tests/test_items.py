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
