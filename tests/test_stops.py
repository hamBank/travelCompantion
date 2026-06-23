import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend.models import ItineraryItem


@pytest.fixture
def trip(client: TestClient):
    return client.post("/trips/", json={"name": "Test Trip"}).json()


def test_create_stop(client: TestClient, trip):
    r = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Paris", "country": "France", "status": "planned"
    })
    assert r.status_code == 201
    data = r.json()
    assert data["location"] == "Paris"
    assert data["trip_id"] == trip["id"]


def test_create_stop_trip_not_found(client: TestClient):
    r = client.post("/trips/99999/stops", json={"location": "X", "status": "planned"})
    assert r.status_code == 404


def test_list_stops_ordered(client: TestClient, trip):
    client.post(f"/trips/{trip['id']}/stops", json={"location": "C", "sort_order": 3, "status": "planned"})
    client.post(f"/trips/{trip['id']}/stops", json={"location": "A", "sort_order": 1, "status": "planned"})
    client.post(f"/trips/{trip['id']}/stops", json={"location": "B", "sort_order": 2, "status": "planned"})

    stops = client.get(f"/trips/{trip['id']}/stops").json()
    assert [s["location"] for s in stops] == ["A", "B", "C"]


def test_get_stop(client: TestClient, trip):
    created = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Lyon", "status": "planned"
    }).json()
    r = client.get(f"/stops/{created['id']}")
    assert r.status_code == 200
    assert r.json()["location"] == "Lyon"


def test_get_stop_not_found(client: TestClient):
    assert client.get("/stops/99999").status_code == 404


def test_update_stop_status(client: TestClient, trip):
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Madrid", "status": "planned"
    }).json()
    r = client.patch(f"/stops/{stop['id']}", json={"status": "confirmed"})
    assert r.status_code == 200
    assert r.json()["status"] == "confirmed"


def test_update_stop_dates(client: TestClient, trip):
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Venice", "status": "planned"
    }).json()
    r = client.patch(f"/stops/{stop['id']}", json={
        "arrive": "2026-08-10T00:00:00",
        "depart": "2026-08-13T00:00:00",
    })
    assert r.status_code == 200
    assert "2026-08-10" in r.json()["arrive"]


def test_accommodation_is_an_item(client: TestClient, trip):
    # Accommodation is no longer a Stop field — it's an ItineraryItem (kind=accommodation),
    # with check-in/out stored in the item's free-form `details`.
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Florence", "status": "planned"
    }).json()
    r = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "accommodation",
        "name": "Hotel Dante",
        "status": "pending",
        "details": {"checkin": "2026-08-10T15:00", "checkout": "2026-08-13T10:00"},
    })
    assert r.status_code == 201
    data = r.json()
    assert data["kind"] == "accommodation"
    assert data["name"] == "Hotel Dante"
    assert data["details"]["checkin"] == "2026-08-10T15:00"

    # And it shows up under the stop.
    items = client.get(f"/stops/{stop['id']}/items").json()
    assert any(i["kind"] == "accommodation" and i["name"] == "Hotel Dante" for i in items)


def test_stops_ordered_chronologically(client: TestClient, trip):
    # A stop added later but dated earlier must sort into its chronological place,
    # regardless of creation order / sort_order.
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Late", "arrive": "2026-08-20T00:00:00", "sort_order": 0, "status": "planned"
    })
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Early", "arrive": "2026-08-10T00:00:00", "sort_order": 99, "status": "planned"
    })
    stops = client.get(f"/trips/{trip['id']}/stops").json()
    assert [s["location"] for s in stops] == ["Early", "Late"]


def test_delete_stop(client: TestClient, trip):
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Temp", "status": "planned"
    }).json()
    r = client.delete(f"/stops/{stop['id']}")
    assert r.status_code == 204
    assert client.get(f"/stops/{stop['id']}").status_code == 404


def test_delete_stop_cascades_items(client: TestClient, trip, session: Session):
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Naples", "status": "planned"
    }).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Pompeii", "status": "pending"
    })

    client.delete(f"/stops/{stop['id']}")

    remaining = session.exec(
        select(ItineraryItem).where(ItineraryItem.stop_id == stop["id"])
    ).all()
    assert remaining == []


def test_reorder_stop(client: TestClient, trip):
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Geneva", "sort_order": 1, "status": "planned"
    }).json()
    r = client.patch(f"/stops/{stop['id']}/reorder", json={"sort_order": 5})
    assert r.status_code == 200
    assert r.json()["sort_order"] == 5
