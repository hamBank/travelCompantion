"""Tests for POST /trips/{trip_id}/reschedule (plan 16a) and the pure shifting
logic it's built on (backend/reschedule.py). See
docs/plans/plan-16a-reschedule-api.md's "Tests" section — this file's cases
mirror that list."""
import io
import re
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import auth, permissions
from backend.models import (
    ItemAttachment, ItemHistory, NotificationLog, TripMembership, TripRole,
)
from backend.reschedule import (
    ITEM_DATETIME_KEYS, item_primary_dt, shift_datetime_str, shift_item,
    stop_delta_days,
)


# ── Unit tests: backend/reschedule.py ───────────────────────────────────────

def test_shift_datetime_str_date_only_stays_date_only():
    assert shift_datetime_str("2026-08-10", 4) == "2026-08-14"


def test_shift_datetime_str_keeps_time_of_day():
    assert shift_datetime_str("2026-08-10T10:30", 4) == "2026-08-14T10:30"


def test_shift_datetime_str_seconds_preserved_iff_present():
    # With seconds in the input, they're kept (and only they).
    assert shift_datetime_str("2026-08-10T10:30:15", 1) == "2026-08-11T10:30:15"
    # Without seconds in the input, none are injected.
    assert shift_datetime_str("2026-08-10T10:30", 1) == "2026-08-11T10:30"


def test_shift_datetime_str_month_year_rollover():
    assert shift_datetime_str("2026-12-30T23:00", 4) == "2027-01-03T23:00"


def test_shift_datetime_str_negative_delta():
    assert shift_datetime_str("2026-08-10T10:30", -3) == "2026-08-07T10:30"


def test_shift_datetime_str_unparseable_unchanged():
    assert shift_datetime_str("not a date", 4) == "not a date"
    assert shift_datetime_str("", 4) == ""
    assert shift_datetime_str(None, 4) is None


def test_stop_delta_days_arrive_based():
    old = datetime(2026, 9, 30)
    new = datetime(2026, 10, 4)
    assert stop_delta_days(old, datetime(2026, 10, 3), new, datetime(2026, 10, 7)) == 4


def test_stop_delta_days_depart_fallback_when_no_arrive():
    old = datetime(2026, 9, 30)
    new = datetime(2026, 10, 4)
    assert stop_delta_days(None, old, None, new) == 4


def test_stop_delta_days_undated_is_zero():
    assert stop_delta_days(None, None, datetime(2026, 10, 4), datetime(2026, 10, 7)) == 0


def test_stop_delta_days_negative():
    old = datetime(2026, 10, 4)
    new = datetime(2026, 9, 30)
    assert stop_delta_days(old, None, new, None) == -4


class _FakeItem:
    """Minimal stand-in for ItineraryItem — shift_item only touches
    .scheduled_at/.details/.kind, so a real ORM row isn't needed here."""
    def __init__(self, scheduled_at=None, details=None, kind="activity"):
        self.scheduled_at = scheduled_at
        self.details = details or {}
        self.kind = kind


@pytest.mark.parametrize("key", ITEM_DATETIME_KEYS)
def test_shift_item_covers_each_datetime_key(key):
    item = _FakeItem(details={key: "2026-08-10T09:00"})
    changed = shift_item(item, 3)
    assert changed is True
    assert item.details[key] == "2026-08-13T09:00"


def test_shift_item_covers_scheduled_at():
    item = _FakeItem(scheduled_at=datetime(2026, 8, 10, 9, 0))
    assert shift_item(item, 3) is True
    assert item.scheduled_at == datetime(2026, 8, 13, 9, 0)


def test_shift_item_details_reassigned_new_dict_identity():
    item = _FakeItem(details={"checkin": "2026-08-10T15:00"})
    original_details = item.details
    shift_item(item, 2)
    assert item.details is not original_details
    assert item.details["checkin"] == "2026-08-12T15:00"


def test_shift_item_delta_zero_returns_false_and_untouched():
    item = _FakeItem(scheduled_at=datetime(2026, 8, 10), details={"checkin": "2026-08-10T15:00"})
    original_details = item.details
    assert shift_item(item, 0) is False
    assert item.scheduled_at == datetime(2026, 8, 10)
    assert item.details is original_details


def test_shift_item_untouched_when_no_dates_present():
    item = _FakeItem()
    assert shift_item(item, 5) is False


# The one thing that stops a ninth date-bearing field from silently not
# shifting: assert the D3 key list agrees with what ItemEditModal.jsx
# actually renders as datetime-local inputs.
def test_item_datetime_keys_matches_frontend_edit_modal():
    path = "frontend/src/components/ItemEditModal.jsx"
    with open(path, encoding="utf-8") as f:
        src = f.read()
    frontend_keys = set(re.findall(r"datetime-local\" value=\{d\('(\w+)'\)", src))
    assert re.search(r"core\.scheduled_at", src), "expected core.scheduled_at usage in ItemEditModal.jsx"
    frontend_keys.add("scheduled_at")
    assert set(ITEM_DATETIME_KEYS) | {"scheduled_at"} == frontend_keys


# ── API tests ────────────────────────────────────────────────────────────────

@pytest.fixture
def trip(client: TestClient):
    return client.post("/trips/", json={"name": "Reschedule Trip"}).json()


def _stop(client, trip, **overrides):
    payload = {"location": "Kyoto", "status": "planned"}
    payload.update(overrides)
    return client.post(f"/trips/{trip['id']}/stops", json=payload).json()


def test_reschedule_moves_stop_and_shifts_items(client: TestClient, trip, session: Session):
    stop = _stop(client, trip, arrive="2026-09-30T00:00", depart="2026-10-03T00:00")
    flight = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Inbound", "status": "pending",
        "details": {"depart_time": "2026-09-30T09:00", "arrive_time": "2026-09-30T11:00"},
    }).json()
    accommodation = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "accommodation", "name": "Ryokan", "status": "pending",
        "details": {"checkin": "2026-09-30T15:00", "checkout": "2026-10-03T10:00", "bag_drop": "2026-09-30T13:00"},
    }).json()
    activity = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Fushimi Inari", "status": "pending",
        "scheduled_at": "2026-10-01T09:00",
    }).json()
    undated = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "note", "name": "Pack umbrella", "status": "pending",
    }).json()

    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": stop["id"], "arrive": "2026-10-04T00:00", "depart": "2026-10-07T00:00"}],
    })
    assert r.status_code == 200
    body = r.json()

    updated_stop = next(s for s in body["stops"] if s["id"] == stop["id"])
    assert updated_stop["arrive"].startswith("2026-10-04")
    assert updated_stop["depart"].startswith("2026-10-07")

    shifted_ids = {s["item_id"] for s in body["shifted_items"]}
    assert shifted_ids == {flight["id"], accommodation["id"], activity["id"]}
    for s in body["shifted_items"]:
        assert s["delta_days"] == 4
        assert s["stop_id"] == stop["id"]

    flight_after = client.get(f"/items/{flight['id']}").json()
    assert flight_after["details"]["depart_time"] == "2026-10-04T09:00"
    assert flight_after["details"]["arrive_time"] == "2026-10-04T11:00"

    accom_after = client.get(f"/items/{accommodation['id']}").json()
    assert accom_after["details"]["checkin"] == "2026-10-04T15:00"
    assert accom_after["details"]["checkout"] == "2026-10-07T10:00"
    assert accom_after["details"]["bag_drop"] == "2026-10-04T13:00"

    activity_after = client.get(f"/items/{activity['id']}").json()
    assert activity_after["scheduled_at"] == "2026-10-05T09:00:00"

    undated_after = client.get(f"/items/{undated['id']}").json()
    assert undated_after["scheduled_at"] is None

    histories = session.exec(select(ItemHistory).where(ItemHistory.item_id == flight["id"])).all()
    assert any(h.op == "update" and h.source == "reschedule" for h in histories)
    # Exactly one history row per shifted item from this call.
    for item_id in shifted_ids:
        rescheduled = [h for h in session.exec(select(ItemHistory).where(ItemHistory.item_id == item_id)).all()
                       if h.source == "reschedule"]
        assert len(rescheduled) == 1
    # The undated item got no reschedule history row at all.
    assert not [h for h in session.exec(select(ItemHistory).where(ItemHistory.item_id == undated["id"])).all()
                if h.source == "reschedule"]


def test_reschedule_resize_only_no_item_changes(client: TestClient, trip):
    stop = _stop(client, trip, arrive="2026-09-30T00:00", depart="2026-10-03T00:00")
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Something", "status": "pending",
        "scheduled_at": "2026-10-01T09:00",
    }).json()

    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": stop["id"], "arrive": "2026-09-30T00:00", "depart": "2026-10-05T00:00"}],
    })
    assert r.status_code == 200
    body = r.json()
    assert body["shifted_items"] == []
    item_after = client.get(f"/items/{item['id']}").json()
    assert item_after["scheduled_at"] == "2026-10-01T09:00:00"


def test_reschedule_undated_stop_delta_zero(client: TestClient, trip):
    stop = _stop(client, trip)  # no arrive/depart
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Something", "status": "pending",
        "scheduled_at": "2026-10-01T09:00",
    }).json()

    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": stop["id"], "arrive": "2026-10-04T00:00", "depart": "2026-10-07T00:00"}],
    })
    assert r.status_code == 200
    assert r.json()["shifted_items"] == []
    item_after = client.get(f"/items/{item['id']}").json()
    assert item_after["scheduled_at"] == "2026-10-01T09:00:00"


def test_reschedule_overlapping_result_allowed(client: TestClient, trip):
    stop_a = _stop(client, trip, location="A", arrive="2026-10-01T00:00", depart="2026-10-03T00:00")
    stop_b = _stop(client, trip, location="B", arrive="2026-10-10T00:00", depart="2026-10-12T00:00")

    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": stop_b["id"], "arrive": "2026-10-01T00:00", "depart": "2026-10-03T00:00"}],
    })
    assert r.status_code == 200


def test_reschedule_creates_returns_client_ref_mapping(client: TestClient, trip):
    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "creates": [{"location": "Hakone", "country": "JP", "arrive": "2026-10-05T00:00",
                     "depart": "2026-10-06T00:00", "timezone": "GMT+9", "client_ref": "tmp-1"}],
    })
    assert r.status_code == 200
    body = r.json()
    assert len(body["created"]) == 1
    assert body["created"][0]["client_ref"] == "tmp-1"
    new_id = body["created"][0]["id"]
    assert any(s["id"] == new_id and s["location"] == "Hakone" for s in body["stops"])


def test_reschedule_deletes_cascade(client: TestClient, trip, session: Session):
    stop = _stop(client, trip)
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Something", "status": "pending",
    }).json()
    client.post(f"/items/{item['id']}/attachments",
                files={"file": ("ticket.pdf", io.BytesIO(b"%PDF-1.4 fake"), "application/pdf")})
    expense = client.post(f"/trips/{trip['id']}/expenses", json={
        "name": "Souvenir", "amount": "10 USD", "stop_id": stop["id"], "item_id": item["id"],
    }).json()

    r = client.post(f"/trips/{trip['id']}/reschedule", json={"deletes": [stop["id"]]})
    assert r.status_code == 200
    assert client.get(f"/stops/{stop['id']}").status_code == 404
    assert session.exec(select(ItemAttachment).where(ItemAttachment.item_id == item["id"])).all() == []

    from backend.models import Expense
    remaining_expense = session.exec(select(Expense).where(Expense.id == expense["id"])).first()
    assert remaining_expense is not None
    assert remaining_expense.stop_id is None
    assert remaining_expense.item_id is None


def test_reschedule_atomicity_conflict_blocks_whole_batch(client: TestClient, trip):
    stop_a = _stop(client, trip, location="A", arrive="2026-10-01T00:00", depart="2026-10-03T00:00")
    stop_b = _stop(client, trip, location="B", arrive="2026-10-10T00:00", depart="2026-10-12T00:00")

    # A base that doesn't match stop_b's real current value → conflict.
    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [
            {"stop_id": stop_a["id"], "arrive": "2026-10-05T00:00", "depart": "2026-10-07T00:00"},
            {"stop_id": stop_b["id"], "arrive": "2026-10-15T00:00", "depart": "2026-10-17T00:00",
             "base": {"arrive": "2026-01-01T00:00:00", "depart": "2026-01-02T00:00:00"}},
        ],
    })
    assert r.status_code == 409
    assert "conflicts" in r.json()["detail"]

    # stop_a (the first, individually-valid move) must NOT have been applied.
    stop_a_after = client.get(f"/stops/{stop_a['id']}").json()
    assert stop_a_after["arrive"].startswith("2026-10-01")


def test_reschedule_viewer_forbidden(client: TestClient, trip, session: Session, monkeypatch):
    # Same pattern as test_expenses.py's test_viewer_cannot_create_expense.
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    session.add(TripMembership(trip_id=trip["id"], user_email="viewer@example.com", role=TripRole.viewer))
    session.commit()

    token = auth.create_jwt({"email": "viewer@example.com"})
    r = client.post(
        f"/trips/{trip['id']}/reschedule", json={},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403


def test_reschedule_stop_from_another_trip_404(client: TestClient, trip):
    other_trip = client.post("/trips/", json={"name": "Other Trip"}).json()
    other_stop = _stop(client, other_trip)

    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": other_stop["id"], "arrive": "2026-10-01T00:00", "depart": "2026-10-02T00:00"}],
    })
    assert r.status_code == 404


def test_reschedule_id_in_both_moves_and_deletes_422(client: TestClient, trip):
    stop = _stop(client, trip)
    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": stop["id"], "arrive": "2026-10-01T00:00", "depart": "2026-10-02T00:00"}],
        "deletes": [stop["id"]],
    })
    assert r.status_code == 422


def test_reschedule_empty_body_is_noop(client: TestClient, trip):
    stop = _stop(client, trip, arrive="2026-10-01T00:00", depart="2026-10-02T00:00")
    r = client.post(f"/trips/{trip['id']}/reschedule", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["shifted_items"] == []
    assert body["created"] == []
    still = next(s for s in body["stops"] if s["id"] == stop["id"])
    assert still["arrive"].startswith("2026-10-01")


def test_reschedule_inverse_round_trip(client: TestClient, trip):
    stop = _stop(client, trip, arrive="2026-09-30T00:00", depart="2026-10-03T00:00")
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Inbound", "status": "pending",
        "details": {"depart_time": "2026-09-30T09:00"},
    }).json()

    r1 = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": stop["id"], "arrive": "2026-10-04T00:00", "depart": "2026-10-07T00:00"}],
        "creates": [{"location": "Hakone", "arrive": "2026-10-05T00:00", "depart": "2026-10-06T00:00", "client_ref": "tmp-1"}],
    })
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1["undo_lossy"] is False

    r2 = client.post(f"/trips/{trip['id']}/reschedule", json=body1["inverse"])
    assert r2.status_code == 200

    stop_after = client.get(f"/stops/{stop['id']}").json()
    assert stop_after["arrive"].startswith("2026-09-30")
    assert stop_after["depart"].startswith("2026-10-03")

    item_after = client.get(f"/items/{item['id']}").json()
    assert item_after["details"]["depart_time"] == "2026-09-30T09:00"

    # The created Hakone stop was deleted by the inverse.
    created_id = body1["created"][0]["id"]
    assert client.get(f"/stops/{created_id}").status_code == 404


def test_reschedule_inverse_lossy_when_deletes_present(client: TestClient, trip):
    stop = _stop(client, trip)
    r = client.post(f"/trips/{trip['id']}/reschedule", json={"deletes": [stop["id"]]})
    assert r.status_code == 200
    assert r.json()["undo_lossy"] is True
    assert r.json()["inverse"]["creates"] == []


def test_reschedule_clears_notification_log_for_future_shifted_item(client: TestClient, trip, session: Session):
    stop = _stop(client, trip, arrive="2026-09-30T00:00", depart="2026-10-03T00:00")
    future_item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "Future flight", "status": "pending",
        "details": {"depart_time": "2026-09-30T09:00"},
    }).json()
    unshifted_item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "note", "name": "No dates here", "status": "pending",
    }).json()

    session.add(NotificationLog(item_id=future_item["id"], kind="departure"))
    session.add(NotificationLog(item_id=unshifted_item["id"], kind="departure"))
    session.commit()

    r = client.post(f"/trips/{trip['id']}/reschedule", json={
        "moves": [{"stop_id": stop["id"], "arrive": "2026-10-04T00:00", "depart": "2026-10-07T00:00"}],
    })
    assert r.status_code == 200

    remaining_future = session.exec(
        select(NotificationLog).where(NotificationLog.item_id == future_item["id"])
    ).all()
    assert remaining_future == []

    remaining_unshifted = session.exec(
        select(NotificationLog).where(NotificationLog.item_id == unshifted_item["id"])
    ).all()
    assert len(remaining_unshifted) == 1


def test_item_primary_dt_matches_d3_priority():
    flight = _FakeItem(kind="flight", details={"depart_time": "2026-08-10T09:00", "arrive_time": "2026-08-10T11:00"})
    assert item_primary_dt(flight) == datetime(2026, 8, 10, 9, 0)

    accommodation = _FakeItem(kind="accommodation", details={"checkin": "2026-08-10T15:00"})
    assert item_primary_dt(accommodation) == datetime(2026, 8, 10, 15, 0)

    activity = _FakeItem(kind="activity", scheduled_at=datetime(2026, 8, 10, 9, 0))
    assert item_primary_dt(activity) == datetime(2026, 8, 10, 9, 0)

    nothing = _FakeItem(kind="note")
    assert item_primary_dt(nothing) is None
