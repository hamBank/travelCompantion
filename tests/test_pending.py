import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from backend.models import PendingChange, PendingStatus, ItemKind, ItineraryItem


@pytest.fixture
def trip_stop(client: TestClient):
    trip = client.post("/trips/", json={"name": "T"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={"location": "Rome", "status": "planned"}).json()
    return trip, stop


def _mk_pending(session: Session, trip_id=None, stop_id=None, op="create",
                target_item_id=None, created_by="dev@local", name="Colosseum"):
    pc = PendingChange(
        created_by=created_by, source="upload", trip_id=trip_id,
        suggested_stop_id=stop_id, op=op, target_item_id=target_item_id,
        kind=ItemKind.activity,
        payload={"name": name, "scheduled_at": None, "cost": "€20",
                 "link": "", "notes": "", "details": {"location": "Rome"}},
        confidence="high", match_reason="matched by date",
    )
    session.add(pc); session.commit(); session.refresh(pc)
    return pc


def test_list_pending(client, session, trip_stop):
    trip, stop = trip_stop
    _mk_pending(session, trip_id=trip["id"], stop_id=stop["id"])
    _mk_pending(session, trip_id=None)  # unassigned
    r = client.get("/pending")
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_list_pending_filtered_by_trip_includes_unassigned(client, session, trip_stop):
    trip, stop = trip_stop
    other = client.post("/trips/", json={"name": "Other"}).json()
    _mk_pending(session, trip_id=trip["id"], stop_id=stop["id"])   # this trip
    _mk_pending(session, trip_id=other["id"])                       # other trip
    _mk_pending(session, trip_id=None)                              # unassigned
    r = client.get(f"/pending?trip_id={trip['id']}")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 2  # this-trip + unassigned, not the other trip
    assert all(row["trip_id"] in (trip["id"], None) for row in rows)


def test_apply_pending_creates_item(client, session, trip_stop):
    trip, stop = trip_stop
    pc = _mk_pending(session, trip_id=trip["id"], stop_id=stop["id"])
    r = client.post(f"/pending/{pc.id}/apply")
    assert r.status_code == 200
    assert r.json()["name"] == "Colosseum"
    assert r.json()["stop_id"] == stop["id"]
    # item now exists on the stop
    items = client.get(f"/stops/{stop['id']}/items").json()
    assert len(items) == 1
    # pending no longer listed
    assert client.get("/pending").json() == []


def test_apply_without_stop_fails(client, session, trip_stop):
    trip, _ = trip_stop
    pc = _mk_pending(session, trip_id=trip["id"], stop_id=None)
    r = client.post(f"/pending/{pc.id}/apply")
    assert r.status_code == 400


def test_apply_without_trip_fails(client, session):
    pc = _mk_pending(session, trip_id=None)
    r = client.post(f"/pending/{pc.id}/apply")
    assert r.status_code == 400


def test_apply_update_op_modifies_existing_item(client, session, trip_stop):
    trip, stop = trip_stop
    created = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Old name", "status": "pending"
    }).json()
    pc = _mk_pending(session, trip_id=trip["id"], stop_id=stop["id"],
                     op="update", target_item_id=created["id"], name="New name")
    r = client.post(f"/pending/{pc.id}/apply")
    assert r.status_code == 200
    assert r.json()["id"] == created["id"]
    assert r.json()["name"] == "New name"
    # no second item created
    assert len(client.get(f"/stops/{stop['id']}/items").json()) == 1


def test_discard_pending(client, session, trip_stop):
    trip, stop = trip_stop
    pc = _mk_pending(session, trip_id=trip["id"], stop_id=stop["id"])
    assert client.post(f"/pending/{pc.id}/discard").status_code == 204
    assert client.get("/pending").json() == []
    # no item was created
    assert client.get(f"/stops/{stop['id']}/items").json() == []


def test_update_pending_edits_fields(client, session, trip_stop):
    trip, stop = trip_stop
    pc = _mk_pending(session, trip_id=trip["id"], stop_id=None)
    r = client.patch(f"/pending/{pc.id}", json={
        "suggested_stop_id": stop["id"],
        "kind": "restaurant",
        "payload": {"name": "Trattoria", "scheduled_at": None, "cost": "",
                    "link": "", "notes": "", "details": {}},
    })
    assert r.status_code == 200
    assert r.json()["suggested_stop_id"] == stop["id"]
    assert r.json()["kind"] == "restaurant"
    assert r.json()["payload"]["name"] == "Trattoria"


def test_changing_trip_resets_stop_and_op(client, session, trip_stop):
    trip, stop = trip_stop
    other = client.post("/trips/", json={"name": "Other"}).json()
    pc = _mk_pending(session, trip_id=trip["id"], stop_id=stop["id"],
                     op="update", target_item_id=1)
    r = client.patch(f"/pending/{pc.id}", json={"trip_id": other["id"]})
    assert r.status_code == 200
    body = r.json()
    assert body["trip_id"] == other["id"]
    assert body["suggested_stop_id"] is None
    assert body["op"] == "create"
    assert body["target_item_id"] is None


def test_apply_already_decided_conflicts(client, session, trip_stop):
    trip, stop = trip_stop
    pc = _mk_pending(session, trip_id=trip["id"], stop_id=stop["id"])
    assert client.post(f"/pending/{pc.id}/apply").status_code == 200
    assert client.post(f"/pending/{pc.id}/apply").status_code == 409  # already applied
