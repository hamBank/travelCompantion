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


def test_stops_same_arrival_break_on_departure(client: TestClient, trip):
    # Same arrival date → earliest departure sorts first.
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Longer", "arrive": "2026-08-10T00:00:00", "depart": "2026-08-14T00:00:00", "status": "planned"
    })
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Shorter", "arrive": "2026-08-10T00:00:00", "depart": "2026-08-11T00:00:00", "status": "planned"
    })
    stops = client.get(f"/trips/{trip['id']}/stops").json()
    assert [s["location"] for s in stops] == ["Shorter", "Longer"]


def test_stops_same_arrival_date_ignores_arrival_time(client: TestClient, trip):
    # Same arrival DATE but different arrival times must still break on departure
    # date, not arrival time (regression: Lyon arr 4 Aug AM / dep 6 Aug should sit
    # after Geneva arr 4 Aug PM / dep 4 Aug).
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Lyon", "arrive": "2026-08-04T09:00:00", "depart": "2026-08-06T00:00:00", "status": "planned"
    })
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Geneva", "arrive": "2026-08-04T14:00:00", "depart": "2026-08-04T18:00:00", "status": "planned"
    })
    stops = client.get(f"/trips/{trip['id']}/stops").json()
    assert [s["location"] for s in stops] == ["Geneva", "Lyon"]


def test_date_warnings_flags_out_of_range_item(client: TestClient, trip):
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Lyon", "arrive": "2026-08-04T00:00:00", "depart": "2026-08-06T00:00:00", "status": "planned"
    }).json()
    # A later stop, so Lyon is NOT the final stop (its "after departure" still flags).
    home = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Home", "arrive": "2026-08-20T00:00:00", "depart": "2026-08-22T00:00:00", "status": "planned"
    }).json()
    # In range — no warning.
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Good", "status": "pending", "scheduled_at": "2026-08-05T10:00:00"
    })
    # Year typo — a year early, outside the window.
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Typo", "status": "pending", "scheduled_at": "2025-08-05T17:05:00"
    })
    # Rail uses details.depart_time, after Lyon's departure (Lyon isn't last → flagged).
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "rail", "name": "LateTrain", "status": "pending",
        "details": {"depart_time": "2026-08-09T09:00"}
    })
    # Homeward flight departs after the FINAL stop — exempt, no warning.
    client.post(f"/stops/{home['id']}/items", json={
        "kind": "flight", "name": "FlightHome", "status": "pending",
        "details": {"depart_time": "2026-08-25T09:00"}
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    # Scope to the out-of-range-item category — this fixture's undated gap
    # (Lyon → Home with no transport, and Home's un-lodged 2-night span) also
    # trips the newer coverage/transport checks, which are covered separately below.
    names = {w["name"]: w["reason"] for w in warnings if w["reason"] in ("before stop arrival", "after stop departure")}
    assert names == {"Typo": "before stop arrival", "LateTrain": "after stop departure"}


def test_date_warnings_accommodation_span_overlaps_window(client: TestClient, trip):
    # Paris: arrive 14 Aug (after an overnight flight), depart 17 Aug. Not the last
    # stop, so "after departure" still applies here.
    paris = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Paris", "arrive": "2026-08-14T08:00:00", "depart": "2026-08-17T00:00:00", "status": "planned"
    }).json()
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Home", "arrive": "2026-08-20T00:00:00", "depart": "2026-08-22T00:00:00", "status": "planned"
    })
    # Hotel booked from the night of the 13th (room ready for the dawn arrival) through
    # checkout on departure day. Check-in alone is "before arrival", but the stay
    # overlaps the stop — must NOT be flagged.
    client.post(f"/stops/{paris['id']}/items", json={
        "kind": "accommodation", "name": "Hotel Lutetia", "status": "pending",
        "details": {"checkin": "2026-08-13T15:00", "checkout": "2026-08-17T10:00"},
    })
    # A stay that ends before the stop even begins is genuinely misfiled — still flagged.
    client.post(f"/stops/{paris['id']}/items", json={
        "kind": "accommodation", "name": "Wrong Year Hotel", "status": "pending",
        "details": {"checkin": "2025-08-13T15:00", "checkout": "2025-08-17T10:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    names = {w["name"]: w["reason"] for w in warnings if w["reason"] in ("before stop arrival", "after stop departure")}
    assert names == {"Wrong Year Hotel": "before stop arrival"}


def test_date_warnings_accommodation_without_checkout_not_flagged(client: TestClient, trip):
    # Lyon: arrive 5 Aug, depart 8 Aug. A later stop keeps Lyon off the
    # "final stop" exemption.
    lyon = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Lyon", "arrive": "2026-08-05T14:00:00", "depart": "2026-08-08T00:00:00", "status": "planned"
    }).json()
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Home", "arrive": "2026-08-20T00:00:00", "depart": "2026-08-22T00:00:00", "status": "planned"
    })
    # Pullman Lyon: checked in the night before arrival, with no checkout recorded.
    # A lone check-in is an open-ended stay through the stop, not a zero-night one,
    # so it must NOT be flagged "before stop arrival".
    client.post(f"/stops/{lyon['id']}/items", json={
        "kind": "accommodation", "name": "Pullman Lyon", "status": "pending",
        "details": {"checkin": "2026-08-04T22:00"},
    })
    # A check-in after the stop has ended is still genuinely wrong, even with no checkout.
    client.post(f"/stops/{lyon['id']}/items", json={
        "kind": "accommodation", "name": "Way Late Hotel", "status": "pending",
        "details": {"checkin": "2026-08-12T15:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    names = {w["name"]: w["reason"] for w in warnings if w["reason"] in ("before stop arrival", "after stop departure")}
    assert names == {"Way Late Hotel": "after stop departure"}


def test_date_warnings_accommodation_checkout_before_checkin_not_flagged(client: TestClient, trip):
    # Lyon arrives 4 Aug, departs 6 Aug. The check-in is fine (4 Aug), but the
    # check-out is stored *before* the check-in (bad data — e.g. a stale/wrong
    # check-out date). A check-out before check-in is impossible, so it must not be
    # read as the stay ending before arrival.
    lyon = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Lyon", "arrive": "2026-08-04T00:00:00", "depart": "2026-08-06T00:00:00", "status": "planned"
    }).json()
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Home", "arrive": "2026-08-20T00:00:00", "depart": "2026-08-22T00:00:00", "status": "planned"
    })
    client.post(f"/stops/{lyon['id']}/items", json={
        "kind": "accommodation", "name": "Pullman Lyon", "status": "pending",
        "details": {"checkin": "2026-08-04T15:00", "checkout": "2026-08-02T11:00"},
    })
    # Sanity: this exact data was flagged "before stop arrival" before the fix.
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    names = [w["name"] for w in warnings]
    assert "Pullman Lyon" not in names


def test_date_warnings_transit_span_overlaps_window(client: TestClient, trip):
    # Lyon: arrive early 4 Aug, depart 6 Aug. A later stop keeps Lyon off the
    # "final stop" exemption.
    lyon = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Lyon", "arrive": "2026-08-04T07:00:00", "depart": "2026-08-06T00:00:00", "status": "planned"
    }).json()
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Home", "arrive": "2026-08-20T00:00:00", "depart": "2026-08-22T00:00:00", "status": "planned"
    })
    # Overnight train INTO Lyon: leaves the previous city the evening of the 3rd,
    # arrives Lyon the morning of the 4th. Filed on Lyon. Its departure alone is
    # "before arrival", but the journey arrives within the window — must NOT flag.
    client.post(f"/stops/{lyon['id']}/items", json={
        "kind": "rail", "name": "Night Train In", "status": "pending",
        "details": {"depart_time": "2026-08-03T22:30", "arrive_time": "2026-08-04T06:30"},
    })
    # A train whose whole journey is after Lyon's departure is genuinely misfiled.
    client.post(f"/stops/{lyon['id']}/items", json={
        "kind": "rail", "name": "Late Train", "status": "pending",
        "details": {"depart_time": "2026-08-09T09:00", "arrive_time": "2026-08-09T12:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    names = {w["name"]: w["reason"] for w in warnings if w["reason"] in ("before stop arrival", "after stop departure")}
    assert names == {"Late Train": "after stop departure"}


def test_date_warnings_uncovered_accommodation_gap(client: TestClient, trip):
    # Rome: 4 nights (1-5 Aug). One accommodation only covers the first two;
    # the last two nights have nothing booked — a single gap warning, not two.
    rome = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "arrive": "2026-08-01T00:00:00", "depart": "2026-08-05T00:00:00", "status": "planned"
    }).json()
    client.post(f"/stops/{rome['id']}/items", json={
        "kind": "accommodation", "name": "Hotel Roma", "status": "pending",
        "details": {"checkin": "2026-08-01T14:00", "checkout": "2026-08-03T10:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    gaps = [w for w in warnings if w["name"] == "Uncovered accommodation"]
    assert len(gaps) == 1
    assert gaps[0]["item_id"] is None
    assert gaps[0]["stop_location"] == "Rome"
    assert gaps[0]["reason"] == "2 nights uncovered from 2026-08-03"


def test_date_warnings_uncovered_accommodation_fully_covered_not_flagged(client: TestClient, trip):
    # Rome: 3 nights, one accommodation item spanning exactly checkin==arrive,
    # checkout==depart — every night covered, no gap warning.
    rome = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "arrive": "2026-08-01T00:00:00", "depart": "2026-08-04T00:00:00", "status": "planned"
    }).json()
    client.post(f"/stops/{rome['id']}/items", json={
        "kind": "accommodation", "name": "Hotel Roma", "status": "pending",
        "details": {"checkin": "2026-08-01T14:00", "checkout": "2026-08-04T10:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    gaps = [w for w in warnings if w["name"] == "Uncovered accommodation"]
    assert gaps == []


def test_date_warnings_same_day_stop_no_accommodation_not_flagged(client: TestClient, trip):
    # A same-day transit stop (arrive and depart the same calendar day) has zero
    # nights — must never nag for "uncovered" nights regardless of accommodation.
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Transit", "arrive": "2026-08-10T06:00:00", "depart": "2026-08-10T20:00:00", "status": "planned"
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    gaps = [w for w in warnings if w["name"] == "Uncovered accommodation"]
    assert gaps == []


def test_date_warnings_one_night_stop_no_accommodation_not_flagged(client: TestClient, trip):
    # A single-night stop with no accommodation item at all could just be an
    # overnight layover filed without a hotel — not enough signal to nag.
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Layover", "arrive": "2026-08-10T00:00:00", "depart": "2026-08-11T00:00:00", "status": "planned"
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    gaps = [w for w in warnings if w["name"] == "Uncovered accommodation"]
    assert gaps == []


def test_date_warnings_multi_night_stop_no_accommodation_flagged(client: TestClient, trip):
    # A 2+ night stop with literally no accommodation item is worth flagging even
    # though there's no accommodation item to compare gaps against.
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Madrid", "arrive": "2026-08-10T00:00:00", "depart": "2026-08-12T00:00:00", "status": "planned"
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    gaps = [w for w in warnings if w["name"] == "Uncovered accommodation"]
    assert len(gaps) == 1
    assert gaps[0]["reason"] == "2 nights uncovered from 2026-08-10"


def test_date_warnings_missing_inter_stop_transport(client: TestClient, trip):
    # Nice → Turin, different locations, no transport item anywhere near the
    # transition day (4 Aug, where Nice departs and Turin arrives).
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Nice", "arrive": "2026-09-01T00:00:00", "depart": "2026-09-04T00:00:00", "status": "planned"
    })
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Turin", "arrive": "2026-09-04T00:00:00", "depart": "2026-09-07T00:00:00", "status": "planned"
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    missing = [w for w in warnings if w["name"] == "Missing transport"]
    assert len(missing) == 1
    assert missing[0]["item_id"] is None
    assert missing[0]["stop_location"] == "Nice → Turin"
    assert missing[0]["reason"] == "No transport found between Nice and Turin around 2026-09-04"


def test_date_warnings_transport_present_on_transition_day_not_flagged(client: TestClient, trip):
    # Same Nice → Turin transition, but this time a transfer is filed on the
    # transition day — must not nag.
    nice = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Nice", "arrive": "2026-09-01T00:00:00", "depart": "2026-09-04T00:00:00", "status": "planned"
    }).json()
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Turin", "arrive": "2026-09-04T00:00:00", "depart": "2026-09-07T00:00:00", "status": "planned"
    })
    client.post(f"/stops/{nice['id']}/items", json={
        "kind": "transfer", "name": "Car to Turin", "status": "pending",
        "details": {"depart_time": "2026-09-04T09:00", "arrive_time": "2026-09-04T13:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    missing = [w for w in warnings if w["name"] == "Missing transport"]
    assert missing == []


def test_date_warnings_cycling_transport_present_on_transition_day_not_flagged(client: TestClient, trip):
    # Same Nice → Turin transition, but covered by a cycling leg instead of a
    # transfer — cycling is a valid transport kind (models.ItemKind.cycling)
    # and must not be treated as "no transport found".
    nice = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Nice", "arrive": "2026-09-01T00:00:00", "depart": "2026-09-04T00:00:00", "status": "planned"
    }).json()
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Turin", "arrive": "2026-09-04T00:00:00", "depart": "2026-09-07T00:00:00", "status": "planned"
    })
    client.post(f"/stops/{nice['id']}/items", json={
        "kind": "cycling", "name": "Ride to Turin", "status": "pending",
        "scheduled_at": "2026-09-04T09:00",
        "details": {"start_location": "Nice", "end_location": "Turin"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    missing = [w for w in warnings if w["name"] == "Missing transport"]
    assert missing == []


def test_date_warnings_impossible_connection_same_stop(client: TestClient, trip):
    # Two flights filed on the same stop: the second departs while the first is
    # still in the air — an impossible connection, same-timezone assumption holds.
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Zurich", "status": "planned"
    }).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "First Flight", "status": "pending",
        "details": {"depart_time": "2026-08-05T08:00", "arrive_time": "2026-08-05T12:00"},
    })
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Second Flight", "status": "pending",
        "details": {"depart_time": "2026-08-05T10:00", "arrive_time": "2026-08-05T14:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    impossible = [w for w in warnings if "departs before" in w["reason"]]
    assert len(impossible) == 1
    assert impossible[0]["name"] == "Second Flight"
    assert impossible[0]["reason"] == 'departs before "First Flight" arrives'


def test_date_warnings_cross_stop_overlap_under_6h_not_flagged(client: TestClient, trip):
    # Different stops (timezone skew is possible), overlap is only 3h — within the
    # cushion, must not be flagged as an impossible connection.
    stop_a = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "CityA", "status": "planned"
    }).json()
    stop_b = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "CityB", "status": "planned"
    }).json()
    client.post(f"/stops/{stop_a['id']}/items", json={
        "kind": "flight", "name": "Flight A", "status": "pending",
        "details": {"depart_time": "2026-08-06T08:00", "arrive_time": "2026-08-06T12:00"},
    })
    client.post(f"/stops/{stop_b['id']}/items", json={
        "kind": "flight", "name": "Flight B", "status": "pending",
        "details": {"depart_time": "2026-08-06T09:00", "arrive_time": "2026-08-06T13:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    impossible = [w for w in warnings if "departs before" in w["reason"]]
    assert impossible == []


def test_date_warnings_cross_stop_overlap_over_6h_flagged(client: TestClient, trip):
    # Different stops, but the overlap (8h) is well past the timezone-skew cushion —
    # still a real conflict.
    stop_a = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "CityA", "status": "planned"
    }).json()
    stop_b = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "CityB", "status": "planned"
    }).json()
    client.post(f"/stops/{stop_a['id']}/items", json={
        "kind": "flight", "name": "Flight A", "status": "pending",
        "details": {"depart_time": "2026-08-06T04:00", "arrive_time": "2026-08-06T12:00"},
    })
    client.post(f"/stops/{stop_b['id']}/items", json={
        "kind": "flight", "name": "Flight B", "status": "pending",
        "details": {"depart_time": "2026-08-06T04:30", "arrive_time": "2026-08-06T13:00"},
    })
    warnings = client.get(f"/trips/{trip['id']}/date-warnings").json()["warnings"]
    impossible = [w for w in warnings if "departs before" in w["reason"]]
    assert len(impossible) == 1
    assert impossible[0]["name"] == "Flight B"


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
