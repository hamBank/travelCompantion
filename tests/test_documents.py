"""Tests for the document-parse → pending-change builder (no Claude calls)."""
from sqlmodel import select

from backend.routers.documents import build_pending_changes, _match_existing, _compute_diff
from backend.models import Stop, ItineraryItem


def _trip_with_stop(client):
    trip = client.post("/trips/", json={"name": "Paris"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={"location": "Paris", "status": "planned"}).json()
    return trip, stop


def test_multi_item_creates_one_pending_per_leg(client, session):
    trip, stop = _trip_with_stop(client)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    parsed = {"items": [
        {"kind": "flight", "name": "Singapore → Helsinki", "matched_stop_id": stop["id"], "confidence": "high",
         "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35", "arrive_time": "2026-07-25T06:00", "origin": "SIN", "destination": "HEL"}},
        {"kind": "flight", "name": "Helsinki → Paris", "matched_stop_id": stop["id"], "confidence": "high",
         "details": {"flight_number": "AY1571", "depart_time": "2026-07-25T07:35", "arrive_time": "2026-07-25T09:40", "origin": "HEL", "destination": "CDG"}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 2
    assert {pc.payload["details"]["flight_number"] for pc in pcs} == {"AY132", "AY1571"}
    assert all(pc.op == "create" for pc in pcs)


def test_matches_existing_flight_as_update_with_diff(client, session):
    trip, stop = _trip_with_stop(client)
    # Existing flight AY132 on 2026-07-24, no fare_class yet
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "SIN flight", "status": "pending",
        "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35", "origin": "SIN", "destination": "HEL"},
    })
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    parsed = {"items": [
        {"kind": "flight", "name": "Singapore → Helsinki", "matched_stop_id": stop["id"], "confidence": "high",
         "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35", "arrive_time": "2026-07-25T06:00",
                     "origin": "SIN", "destination": "HEL", "fare_class": "Business"}},
        {"kind": "flight", "name": "Helsinki → Paris", "matched_stop_id": stop["id"], "confidence": "high",
         "details": {"flight_number": "AY1571", "depart_time": "2026-07-25T07:35", "origin": "HEL", "destination": "CDG"}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert sorted(pc.op for pc in pcs) == ["create", "update"]
    upd = next(pc for pc in pcs if pc.op == "update")
    assert upd.target_item_id is not None
    assert "fare_class" in upd.diff["after"]
    assert upd.diff["after"]["fare_class"] == "Business"
    cre = next(pc for pc in pcs if pc.op == "create")
    assert cre.payload["details"]["flight_number"] == "AY1571"


def test_no_match_when_flight_number_differs(client, session):
    trip, stop = _trip_with_stop(client)
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Other", "status": "pending",
        "details": {"flight_number": "BA999", "depart_time": "2026-07-24T21:35"},
    })
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    parsed = {"items": [
        {"kind": "flight", "name": "AY132", "matched_stop_id": stop["id"],
         "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35"}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 1 and pcs[0].op == "create"


def test_legacy_single_object_shape_tolerated(client, session):
    trip, stop = _trip_with_stop(client)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    parsed = {"kind": "note", "name": "Reminder", "matched_stop_id": stop["id"], "details": {"description": "x"}}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 1 and pcs[0].kind.value == "note"


def test_empty_result_creates_nothing(client, session):
    trip, stop = _trip_with_stop(client)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    assert build_pending_changes(session, "dev@local", trip["id"], stops, {"items": []}) == []


def test_match_existing_requires_identifier(client, session):
    trip, stop = _trip_with_stop(client)
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "F", "status": "pending",
        "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35"},
    })
    # No flight_number in the incoming details → no match
    assert _match_existing(session, trip["id"], "flight", {"depart_time": "2026-07-24T21:35"}) is None
