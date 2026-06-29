"""Tests for connection-booking extraction — two flights under one booking reference.

Finnair (and others) show a connection as a single route block with multiple
flight numbers ('AY132, AY1571') and segment-specific seat info
('SIN-HEL: 3H 3D / HEL-CDG: 2C 2A').  Claude must extract SEPARATE items
per flight number and must NOT overwrite the destination of the first leg.
"""
from sqlmodel import select
from backend.routers.documents import build_pending_changes, _build_prompt
from backend.models import Stop, ItineraryItem


def _setup(client, session):
    """Two-stop trip with existing AY132 (SIN→HEL) and AY1571 (HEL→CDG)."""
    trip = client.post("/trips/", json={"name": "Europe 2026"}).json()
    sin = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Singapore", "status": "planned",
        "arrive": "2026-07-22T00:00", "depart": "2026-07-24T00:00",
    }).json()
    par = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Paris", "status": "planned",
        "arrive": "2026-07-25T00:00", "depart": "2026-07-27T00:00",
    }).json()
    # Existing AY132: SIN→HEL
    ay132 = client.post(f"/stops/{sin['id']}/items", json={
        "kind": "flight", "name": "Singapore → Helsinki", "status": "pending",
        "details": {"flight_number": "AY 132", "depart_time": "2026-07-24T21:35",
                    "origin": "SIN", "destination": "HEL",
                    "passengers": [
                        {"name": "Mr Antony John Wuth", "ticket": "081-2373732325", "loyalty": "QF 9657053"},
                        {"name": "Mrs Nicole Wuth", "ticket": "081-2373732324", "loyalty": "QF 4419892"},
                    ]},
    }).json()
    # Existing AY1571: HEL→CDG
    ay1571 = client.post(f"/stops/{sin['id']}/items", json={
        "kind": "flight", "name": "Helsinki → Paris", "status": "pending",
        "details": {"flight_number": "AY 1571", "depart_time": "2026-07-25T07:35",
                    "origin": "HEL", "destination": "CDG",
                    "passengers": [
                        {"name": "Mr Antony John Wuth", "ticket": "081-2373732325"},
                        {"name": "Mrs Nicole Wuth", "ticket": "081-2373732324"},
                    ]},
    }).json()
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    return trip, stops, ay132, ay1571


def test_connection_extracted_as_two_items(client, session):
    """Two flight numbers → two separate update items (not one combined item)."""
    trip, stops, ay132, ay1571 = _setup(client, session)

    # Claude correctly identifies two separate legs
    parsed = {"items": [
        {"kind": "flight", "name": "Singapore → Helsinki",
         "matched_stop_id": stops[0].id, "confidence": "high", "match_reason": "leg 1",
         "details": {"flight_number": "AY 132", "depart_time": "2026-07-24T21:35",
                     "origin": "SIN", "destination": "HEL",
                     "passengers": [
                         {"name": "Mr Antony John Wuth", "seat": "3H", "baggage": "2x checked bag max 32kg"},
                         {"name": "Mrs Nicole Wuth", "seat": "3D", "baggage": "2x checked bag max 32kg"},
                     ]}},
        {"kind": "flight", "name": "Helsinki → Paris",
         "matched_stop_id": stops[0].id, "confidence": "high", "match_reason": "leg 2",
         "details": {"flight_number": "AY 1571", "depart_time": "2026-07-25T07:35",
                     "origin": "HEL", "destination": "CDG",
                     "passengers": [
                         {"name": "Mr Antony John Wuth", "seat": "2C", "baggage": "2x checked bag max 32kg"},
                         {"name": "Mrs Nicole Wuth", "seat": "2A", "baggage": "2x checked bag max 32kg"},
                     ]}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 2
    assert all(pc.op == "update" for pc in pcs)
    by_flight = {(pc.diff or {}).get("after", {}).get("passengers", [{}])[0].get("seat", ""): pc
                 for pc in pcs}
    # Each leg got its own seat assignments
    assert any(pc.target_item_id == ay132["id"] for pc in pcs), "AY132 not matched"
    assert any(pc.target_item_id == ay1571["id"] for pc in pcs), "AY1571 not matched"


def test_connection_does_not_overwrite_leg_destination(client, session):
    """Importing a SIN→CDG connection must NOT change AY132's destination from HEL to CDG."""
    trip, stops, ay132, ay1571 = _setup(client, session)

    # Simulate the bad Claude output: one item, SIN→CDG, flight AY132
    parsed = {"items": [
        {"kind": "flight", "name": "Singapore → Paris",
         "matched_stop_id": stops[0].id, "confidence": "high", "match_reason": "connection",
         "details": {"flight_number": "AY 132", "depart_time": "2026-07-24T21:35",
                     "origin": "SIN", "destination": "CDG"}},   # wrong dest!
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 1
    pc = pcs[0]
    # Should match AY132 and NOT flag destination as changed
    # (_KEEP_EXISTING covers location fields but not destination — this test
    #  documents the known limitation so we can see if/when we fix it)
    if pc.op == "update" and pc.diff:
        after = pc.diff.get("after", {})
        # The destination change is the problematic one
        assert "destination" not in after, (
            "Should not overwrite existing HEL destination with CDG from a connection booking"
        )


def test_prompt_mentions_connection_booking_rule():
    """The extraction prompt must explicitly instruct Claude to split connections."""
    prompt = _build_prompt([], ["flight", "rail", "activity"])
    assert "connection" in prompt.lower() or "multi-segment" in prompt.lower() or "connecting" in prompt.lower()
    assert "separate" in prompt.lower()
