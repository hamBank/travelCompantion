import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend.models import Trip, Stop, ItineraryItem


def test_create_trip(client: TestClient):
    r = client.post("/trips/", json={"name": "Euro Trip"})
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Euro Trip"
    assert data["id"] is not None
    assert data["start_date"] is None
    assert data["end_date"] is None


def test_create_trip_with_dates(client: TestClient):
    r = client.post("/trips/", json={
        "name": "Summer 2026",
        "start_date": "2026-06-01T00:00:00",
        "end_date": "2026-08-31T00:00:00",
    })
    assert r.status_code == 201
    data = r.json()
    assert "2026-06-01" in data["start_date"]
    assert "2026-08-31" in data["end_date"]


def test_list_trips(client: TestClient):
    client.post("/trips/", json={"name": "Trip A"})
    client.post("/trips/", json={"name": "Trip B"})
    r = client.get("/trips/")
    assert r.status_code == 200
    names = [t["name"] for t in r.json()]
    assert "Trip A" in names
    assert "Trip B" in names


def test_get_trip(client: TestClient):
    created = client.post("/trips/", json={"name": "My Trip"}).json()
    r = client.get(f"/trips/{created['id']}")
    assert r.status_code == 200
    assert r.json()["name"] == "My Trip"


def test_get_trip_not_found(client: TestClient):
    r = client.get("/trips/99999")
    assert r.status_code == 404


def test_update_trip_name(client: TestClient):
    created = client.post("/trips/", json={"name": "Old Name"}).json()
    r = client.patch(f"/trips/{created['id']}", json={"name": "New Name"})
    assert r.status_code == 200
    assert r.json()["name"] == "New Name"


def test_update_trip_dates(client: TestClient):
    created = client.post("/trips/", json={"name": "Dateless"}).json()
    r = client.patch(f"/trips/{created['id']}", json={
        "start_date": "2026-07-01T00:00:00",
        "end_date": "2026-07-14T00:00:00",
    })
    assert r.status_code == 200
    data = r.json()
    assert "2026-07-01" in data["start_date"]
    assert "2026-07-14" in data["end_date"]


def test_update_trip_clears_dates(client: TestClient):
    created = client.post("/trips/", json={
        "name": "Trip",
        "start_date": "2026-01-01T00:00:00",
        "end_date": "2026-01-10T00:00:00",
    }).json()
    r = client.patch(f"/trips/{created['id']}", json={"start_date": None, "end_date": None})
    assert r.status_code == 200
    assert r.json()["start_date"] is None
    assert r.json()["end_date"] is None


def test_update_trip_budget_is_readable_on_list(client: TestClient):
    created = client.post("/trips/", json={"name": "Budgeted"}).json()
    r = client.patch(f"/trips/{created['id']}", json={"budget": "5000 AUD"})
    assert r.status_code == 200
    assert r.json()["budget"] == "5000 AUD"

    listed = next(t for t in client.get("/trips/").json() if t["id"] == created["id"])
    assert listed["budget"] == "5000 AUD"


def test_update_trip_other_fields_leave_budget_untouched(client: TestClient):
    created = client.post("/trips/", json={"name": "Budgeted"}).json()
    client.patch(f"/trips/{created['id']}", json={"budget": "5000 AUD"})
    r = client.patch(f"/trips/{created['id']}", json={"name": "Renamed"})
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed"
    assert r.json()["budget"] == "5000 AUD"


def test_update_trip_budget_clearable_with_null(client: TestClient):
    created = client.post("/trips/", json={"name": "Budgeted"}).json()
    client.patch(f"/trips/{created['id']}", json={"budget": "5000 AUD"})
    r = client.patch(f"/trips/{created['id']}", json={"budget": None})
    assert r.status_code == 200
    assert r.json()["budget"] is None


def test_delete_trip(client: TestClient):
    created = client.post("/trips/", json={"name": "Gone"}).json()
    r = client.delete(f"/trips/{created['id']}")
    assert r.status_code == 204
    assert client.get(f"/trips/{created['id']}").status_code == 404


def test_delete_trip_cascades_stops_and_items(client: TestClient, session: Session):
    trip = client.post("/trips/", json={"name": "Big Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Paris", "status": "planned"
    }).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Eiffel Tower", "status": "pending"
    })

    r = client.delete(f"/trips/{trip['id']}")
    assert r.status_code == 204

    assert session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all() == []
    assert session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop["id"])).all() == []


def test_trip_timeline_returns_stops_and_items(client: TestClient):
    trip = client.post("/trips/", json={"name": "Timeline Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "sort_order": 0, "status": "planned"
    }).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "restaurant", "name": "La Carbonara", "status": "pending"
    })

    r = client.get(f"/trips/{trip['id']}/timeline")
    assert r.status_code == 200
    data = r.json()
    assert len(data["stops"]) == 1
    assert data["stops"][0]["location"] == "Rome"
    assert data["stops"][0]["items"][0]["name"] == "La Carbonara"


def test_timeline_stops_ordered_by_sort_order(client: TestClient):
    trip = client.post("/trips/", json={"name": "Ordered"}).json()
    client.post(f"/trips/{trip['id']}/stops", json={"location": "B", "sort_order": 2, "status": "planned"})
    client.post(f"/trips/{trip['id']}/stops", json={"location": "A", "sort_order": 1, "status": "planned"})
    client.post(f"/trips/{trip['id']}/stops", json={"location": "C", "sort_order": 3, "status": "planned"})

    stops = client.get(f"/trips/{trip['id']}/timeline").json()["stops"]
    assert [s["location"] for s in stops] == ["A", "B", "C"]


def test_export_pdf(client: TestClient):
    trip = client.post("/trips/", json={"name": "PDF Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Lyon", "country": "France",
        "arrive": "2026-08-04T00:00:00", "depart": "2026-08-06T00:00:00", "status": "planned",
    }).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "rail", "name": "Lyon → Dijon", "status": "pending",
        "details": {"depart_time": "2026-08-04T13:16", "origin": "Lyon", "destination": "Dijon"},
    })

    r = client.get(f"/trips/{trip['id']}/export.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert "attachment" in r.headers.get("content-disposition", "")
    assert r.content[:5] == b"%PDF-"
    assert len(r.content) > 800


def test_export_pdf_trip_not_found(client: TestClient):
    assert client.get("/trips/99999/export.pdf").status_code == 404
