"""Tests for the document-parse → pending-change builder (no Claude calls)."""
from sqlmodel import select

from backend.routers.documents import build_pending_changes, _match_existing, _compute_diff, _normalize_tz, _norm_terminal
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
    # flight numbers are normalised: "AY132" → "AY 132"
    assert {pc.payload["details"]["flight_number"] for pc in pcs} == {"AY 132", "AY 1571"}
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
    assert cre.payload["details"]["flight_number"] == "AY 1571"  # normalised


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


def test_normalize_tz_offsets_passthrough():
    assert _normalize_tz("GMT+8", "2026-07-24T21:35") == "GMT+8"
    assert _normalize_tz("+08:00", None) == "GMT+8"
    assert _normalize_tz("UTC-5", None) == "GMT-5"
    assert _normalize_tz("GMT+5:30", None) == "GMT+5:30"


def test_normalize_tz_iana_names_to_offset():
    # Helsinki is UTC+3 in July (DST), Singapore UTC+8 year-round
    assert _normalize_tz("Europe/Helsinki", "2026-07-25T07:35") == "GMT+3"
    assert _normalize_tz("Asia/Singapore", "2026-07-24T21:35") == "GMT+8"


def test_normalize_tz_bare_city_names():
    assert _normalize_tz("Helsinki", "2026-07-25T07:35") == "GMT+3"
    assert _normalize_tz("Singapore", "2026-07-24T21:35") == "GMT+8"


def test_normalize_tz_unknown_passthrough():
    assert _normalize_tz("Narnia", "2026-07-25T07:35") == "Narnia"
    assert _normalize_tz("", None) == ""


def test_build_pending_normalizes_flight_tz(client, session):
    trip, stop = _trip_with_stop(client)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    parsed = {"items": [
        {"kind": "flight", "name": "SIN → HEL", "matched_stop_id": stop["id"],
         "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35",
                     "arrive_time": "2026-07-25T06:00", "depart_tz": "Asia/Singapore",
                     "arrive_tz": "Helsinki"}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    d = pcs[0].payload["details"]
    assert d["depart_tz"] == "GMT+8"
    assert d["arrive_tz"] == "GMT+3"


def test_transit_leg_assigned_to_departing_stop_not_destination(client, session):
    """A transit flight whose departure city isn't a stop should land on the
    last stop before its departure date, not the final destination stop."""
    trip = client.post("/trips/", json={"name": "T"}).json()
    # stop A: Paris, departs 2026-08-19 (where the journey starts)
    stop_a = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Paris", "status": "planned",
        "arrive": "2026-08-16T00:00", "depart": "2026-08-19T00:00",
    }).json()
    # stop B: Canberra, arrives 2026-08-21 (final destination)
    stop_b = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Canberra", "status": "planned",
        "arrive": "2026-08-21T00:00", "depart": "2026-08-23T00:00",
    }).json()

    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()

    # Transit leg DOH→PER departing 2026-08-20.
    # Claude mistakenly matches it to stop B (Canberra, the destination).
    parsed = {"items": [{
        "kind": "flight", "name": "Doha → Perth",
        "matched_stop_id": stop_b["id"],          # wrong: Claude picked destination
        "confidence": "medium",
        "match_reason": "Connects to Canberra stop",
        "details": {
            "flight_number": "QR900",
            "depart_time": "2026-08-20T01:15",   # departs 20 Aug — after Paris stop departs 19 Aug
            "arrive_time": "2026-08-20T14:00",
            "origin": "DOH", "destination": "PER",
        },
    }]}

    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 1
    # Should be corrected to stop A (Paris, last stop whose depart ≤ flight date)
    assert pcs[0].suggested_stop_id == stop_a["id"], (
        f"Transit leg should land on departing stop {stop_a['id']}, got {pcs[0].suggested_stop_id}"
    )


def test_passenger_fields_merged_not_replaced(client, session):
    """Second confirmation for same flight should merge per-passenger arrays, not overwrite."""
    trip, stop = _trip_with_stop(client)
    # Existing flight with passenger 1 as an array
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "SIN → HEL", "status": "pending",
        "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35",
                    "passengers": [{"name": "Mr Antony Wuth", "seat": "12E", "loyalty": "1017525755"}]},
    })
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    # Second email: same flight, adds passenger 2
    parsed = {"items": [{
        "kind": "flight", "name": "SIN → HEL", "matched_stop_id": stop["id"],
        "confidence": "high", "match_reason": "same flight",
        "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35",
                    "passengers": [
                        {"name": "Mr Antony Wuth", "seat": "12E", "loyalty": "1017525755"},
                        {"name": "Mrs Nicole Wuth", "seat": "14A", "loyalty": "1184071914"},
                    ]},
    }]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 1
    pc = pcs[0]
    assert pc.op == "update"
    diff = pc.diff or {}
    # Merged array should contain both passengers
    merged = diff["after"]["passengers"]
    assert len(merged) == 2
    assert any(p["name"] == "Mrs Nicole Wuth" for p in merged)


def test_passenger_fields_not_duplicated_if_same(client, session):
    """Re-importing identical data produces no pending change (diff is empty → skipped)."""
    trip, stop = _trip_with_stop(client)
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "SIN → HEL", "status": "pending",
        "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35",
                    "passengers": [{"name": "Mr Antony Wuth", "seat": "12E"}]},
    })
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    parsed = {"items": [{
        "kind": "flight", "name": "SIN → HEL", "matched_stop_id": stop["id"],
        "confidence": "high", "match_reason": "same flight",
        "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35",
                    "passengers": [{"name": "Mr Antony Wuth", "seat": "12E"}]},
    }]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    # Identical — no pending change created (empty diff is skipped)
    assert len(pcs) == 0


def test_match_existing_requires_identifier(client, session):
    trip, stop = _trip_with_stop(client)
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "F", "status": "pending",
        "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35"},
    })
    # No flight_number in the incoming details → no match
    assert _match_existing(session, trip["id"], "flight", {"depart_time": "2026-07-24T21:35"}) is None


def test_norm_terminal_strips_prefix():
    assert _norm_terminal("Terminal 2B") == "2B"
    assert _norm_terminal("terminal 1") == "1"
    assert _norm_terminal("T2B") == "2B"
    assert _norm_terminal("2B") == "2B"


def test_norm_terminal_rejects_iata_codes():
    # Claude sometimes puts the destination airport code in the terminal field
    assert _norm_terminal("CDG") == ""
    assert _norm_terminal("HEL") == ""
    assert _norm_terminal("SIN") == ""


def test_norm_terminal_keeps_valid_designators():
    # Short non-IATA values that look like terminal letters
    assert _norm_terminal("F") != ""   # could be a terminal letter
    assert _norm_terminal("2E") != ""  # Paris CDG Terminal 2E


# ── _norm_name ─────────────────────────────────────────────────────────────────
from backend.routers.documents import _norm_name

def test_norm_name_strips_leading_title():
    assert _norm_name("Mr Antony Wuth") == _norm_name("Antony Wuth")

def test_norm_name_strips_trailing_title():
    # Surname-first booking format: "Wuth Antony Mr"
    assert _norm_name("Wuth Antony Mr") == _norm_name("Mr Antony Wuth")

def test_norm_name_surname_first_matches_given_first():
    assert _norm_name("Wuth Antony Mr") == _norm_name("Mr Antony Wuth")
    assert _norm_name("Wuth Nicole Mrs") == _norm_name("Mrs Nicole Wuth")

def test_norm_name_middle_name_ignored():
    assert _norm_name("Mr Antony John Wuth") == _norm_name("Mr Antony Wuth")

def test_norm_name_case_insensitive():
    assert _norm_name("WUTH ANTONY MR") == _norm_name("mr antony wuth")


# ── River cruise / sailing-schedule pattern ─────────────────────────────────
# Regression for the AmaWaterways-style booking: one "accommodation" item per
# CONTIGUOUS overnight stay, all sharing the ship's name, with location
# following the Sailing Schedule's "Overnight" town (or an "(overnight
# sailing)" placeholder for the one night the ship cruises between two towns
# with no fixed mooring). Consecutive nights in the SAME town (e.g. two nights
# docked at the disembarkation city) collapse into a single item spanning the
# full stay — NOT one item per calendar night — so they don't look like
# duplicates in the item list.

def _river_cruise_stops(client, trip_id):
    towns = ["Arles", "Avignon", "Viviers", "Tournon", "Sainte Colombe", "Lyon"]
    return {t: client.post(f"/trips/{trip_id}/stops", json={"location": t, "status": "planned"}).json()
            for t in towns}


def test_river_cruise_creates_one_accommodation_item_per_stay(client, session):
    trip = client.post("/trips/", json={"name": "Colors of Provence"}).json()
    towns = _river_cruise_stops(client, trip["id"])
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()

    ship = "AmaKristina"
    # (location, checkin, checkout, stop to match against) — one row per STAY,
    # not per night: the two nights docked in Lyon (Aug 11 & 12) are ONE stay
    # spanning arrival through disembarkation.
    stays = [
        ("Arles",                       "2026-08-06T15:00", "2026-08-07T18:00", "Arles"),
        ("Avignon",                     "2026-08-07T22:00", "2026-08-08T23:59", "Avignon"),
        ("Viviers (overnight sailing)", "2026-08-08T23:59", "2026-08-09T06:30", "Viviers"),
        ("Tournon",                     "2026-08-09T20:00", "2026-08-10T14:30", "Tournon"),
        ("Sainte Colombe",              "2026-08-10T21:30", "2026-08-11T13:00", "Sainte Colombe"),
        ("Lyon",                        "2026-08-11T16:00", "2026-08-13T09:00", "Lyon"),
    ]
    # All stays legitimately share ONE booking reference — this is the exact
    # shape that collapsed to a single item before the _item_key fix below.
    booking_ref = "20755062"
    parsed = {"items": [
        {
            "kind": "accommodation", "name": ship, "scheduled_at": checkin,
            "matched_stop_id": towns[stop_town]["id"],
            "details": {"location": loc, "checkin": checkin, "checkout": checkout,
                        "booking_ref": booking_ref},
            "confidence": "high",
        }
        for loc, checkin, checkout, stop_town in stays
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)

    assert len(pcs) == 6  # a shared booking_ref across stays must NOT collapse them
    assert all(pc.op == "create" for pc in pcs)
    assert all(pc.kind.value == "accommodation" for pc in pcs)
    assert all(pc.payload["name"] == ship for pc in pcs)
    assert all(pc.payload["details"]["booking_ref"] == booking_ref for pc in pcs)

    locations = [pc.payload["details"]["location"] for pc in pcs]
    assert locations == [loc for loc, _, _, _ in stays]
    assert locations.count("Lyon") == 1  # the two Lyon nights merge into one stay, not a dupe

    checkins = [pc.payload["details"]["checkin"] for pc in pcs]
    assert len(set(checkins)) == 6  # every stay is a distinct pending change, none deduped/merged

    lyon_pc = next(pc for pc in pcs if pc.payload["details"]["location"] == "Lyon")
    assert lyon_pc.payload["details"]["checkout"] == "2026-08-13T09:00"  # spans both nights

    # The ambiguous cruising night (no fixed town) is flagged, not silently
    # dropped or mislabeled as a normal stop.
    assert "(overnight sailing)" in locations[2]


def test_accommodation_same_booking_ref_different_checkin_not_deduped(client, session):
    """A second confirmation for a DIFFERENT stay under the same booking_ref
    (e.g. a two-city hotel package, or the cruise nights above) must create a
    separate item rather than being treated as a duplicate of the first."""
    trip, stop = _trip_with_stop(client)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip["id"])).all()
    parsed = {"items": [
        {"kind": "accommodation", "name": "Hotel A", "matched_stop_id": stop["id"],
         "details": {"location": "Paris", "checkin": "2026-08-01", "checkout": "2026-08-02",
                     "booking_ref": "REF1"}},
        {"kind": "accommodation", "name": "Hotel A", "matched_stop_id": stop["id"],
         "details": {"location": "Paris", "checkin": "2026-08-02", "checkout": "2026-08-03",
                     "booking_ref": "REF1"}},
    ]}
    pcs = build_pending_changes(session, "dev@local", trip["id"], stops, parsed)
    assert len(pcs) == 2
