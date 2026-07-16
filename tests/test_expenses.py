"""Actual logged spend (issue #59) — CRUD, linking validation, and the
unlink-not-delete behavior when a linked stop/item/trip goes away."""
import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import auth, permissions
from backend.models import Expense, TripMembership, TripRole


@pytest.fixture
def trip(client: TestClient):
    return client.post("/trips/", json={"name": "Spend Trip"}).json()


@pytest.fixture
def stop(client: TestClient, trip):
    return client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Bangkok", "status": "planned"
    }).json()


@pytest.fixture
def item(client: TestClient, stop):
    return client.post(f"/stops/{stop['id']}/items", json={
        "kind": "purchase", "name": "Night market souvenirs", "status": "pending"
    }).json()


def test_create_expense_minimal(client: TestClient, trip):
    r = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Street food", "amount": "150 THB",
    })
    assert r.status_code == 201
    data = r.json()
    assert data["trip_id"] == trip["id"]
    assert data["name"] == "Street food"
    assert data["amount"] == "150 THB"
    assert data["stop_id"] is None
    assert data["item_id"] is None


def test_create_expense_with_converted_amount_and_links(client: TestClient, trip, stop, item):
    r = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Souvenirs", "amount": "500 THB",
        "converted_amount": 21.37, "converted_currency": "AUD",
        "stop_id": stop["id"], "item_id": item["id"],
    })
    assert r.status_code == 201
    data = r.json()
    assert data["converted_amount"] == 21.37
    assert data["converted_currency"] == "AUD"
    assert data["stop_id"] == stop["id"]
    assert data["item_id"] == item["id"]


def test_create_expense_rejects_stop_from_another_trip(client: TestClient, trip):
    other_trip = client.post("/trips/", json={"name": "Other Trip"}).json()
    other_stop = client.post(f"/trips/{other_trip['id']}/stops", json={
        "location": "Elsewhere", "status": "planned"
    }).json()

    r = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Bad link", "amount": "10 USD", "stop_id": other_stop["id"],
    })
    assert r.status_code == 400


def test_create_expense_rejects_item_from_another_trip(client: TestClient, trip):
    other_trip = client.post("/trips/", json={"name": "Other Trip"}).json()
    other_stop = client.post(f"/trips/{other_trip['id']}/stops", json={
        "location": "Elsewhere", "status": "planned"
    }).json()
    other_item = client.post(f"/stops/{other_stop['id']}/items", json={
        "kind": "activity", "name": "Not this trip's item", "status": "pending"
    }).json()

    r = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Bad link", "amount": "10 USD", "item_id": other_item["id"],
    })
    assert r.status_code == 400


def test_list_expenses_sorted_by_occurred_at(client: TestClient, trip):
    client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Later", "amount": "10 USD", "occurred_at": "2026-08-02T09:00:00",
    })
    client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Earlier", "amount": "5 USD", "occurred_at": "2026-08-01T09:00:00",
    })
    names = [e["name"] for e in client.get(f"/trips/{trip['id']}/expenses").json()]
    assert names == ["Earlier", "Later"]


def test_update_expense(client: TestClient, trip):
    created = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Taxi", "amount": "300 THB",
    }).json()
    r = client.patch(f"/expenses/{created['id']}", json={"amount": "350 THB", "notes": "traffic surcharge"})
    assert r.status_code == 200
    assert r.json()["amount"] == "350 THB"
    assert r.json()["notes"] == "traffic surcharge"


def test_update_expense_rejects_relinking_to_another_trips_stop(client: TestClient, trip):
    other_trip = client.post("/trips/", json={"name": "Other"}).json()
    other_stop = client.post(f"/trips/{other_trip['id']}/stops", json={
        "location": "Elsewhere", "status": "planned"
    }).json()
    created = client.post(f"/trips/{trip['id']}/expenses", json={"name": "X", "amount": "1 USD"}).json()

    r = client.patch(f"/expenses/{created['id']}", json={"stop_id": other_stop["id"]})
    assert r.status_code == 400


def test_delete_expense(client: TestClient, trip):
    created = client.post(f"/trips/{trip['id']}/expenses", json={"name": "X", "amount": "1 USD"}).json()
    assert client.delete(f"/expenses/{created['id']}").status_code == 204
    assert client.get(f"/trips/{trip['id']}/expenses").json() == []


def test_viewer_cannot_create_expense(client: TestClient, trip, session: Session, monkeypatch):
    # `trip` was created with auth disabled (dev@local auto-owner). Flip to a
    # real, membership-scoped viewer identity to exercise the actual 403 path
    # — same pattern as test_ical.py's test_calendar_url_requires_at_least_viewer_access.
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    session.add(TripMembership(trip_id=trip["id"], user_email="viewer@example.com", role=TripRole.viewer))
    session.commit()

    token = auth.create_jwt({"email": "viewer@example.com"})
    r = client.post(
        f"/trips/{trip['id']}/expenses", json={"name": "X", "amount": "1 USD"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403


def test_delete_item_unlinks_rather_than_deletes_expense(client: TestClient, trip, stop, item, session: Session):
    expense = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Linked spend", "amount": "10 USD", "stop_id": stop["id"], "item_id": item["id"],
    }).json()

    assert client.delete(f"/items/{item['id']}").status_code == 204

    remaining = session.exec(select(Expense).where(Expense.id == expense["id"])).first()
    assert remaining is not None
    assert remaining.item_id is None
    assert remaining.stop_id == stop["id"]  # unaffected — only the item link is cleared


def test_delete_stop_unlinks_rather_than_deletes_expense(client: TestClient, trip, stop, item, session: Session):
    expense = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Linked spend", "amount": "10 USD", "stop_id": stop["id"], "item_id": item["id"],
    }).json()

    assert client.delete(f"/stops/{stop['id']}").status_code == 204

    remaining = session.exec(select(Expense).where(Expense.id == expense["id"])).first()
    assert remaining is not None
    assert remaining.stop_id is None
    assert remaining.item_id is None


def test_delete_trip_deletes_its_expenses(client: TestClient, trip, stop, session: Session):
    expense = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Gone with the trip", "amount": "10 USD", "stop_id": stop["id"],
    }).json()

    assert client.delete(f"/trips/{trip['id']}").status_code == 204

    assert session.exec(select(Expense).where(Expense.id == expense["id"])).first() is None
