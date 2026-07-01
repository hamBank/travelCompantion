"""Tests for backend/notifications.py — trigger timing, dedup, and delivery."""
from datetime import datetime, timedelta

import pytest
from sqlmodel import SQLModel, Session, create_engine, select

from backend.models import (
    Trip, Stop, ItineraryItem, ItemKind, TripMembership, TripRole,
    PushSubscription, NotificationLog,
)
from backend.notifications import send_due_notifications
from backend.push import PushSendError


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


def _seed_trip(session, member_email="a@x.com"):
    trip = Trip(name="Test trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    stop = Stop(trip_id=trip.id, location="Somewhere")
    session.add(stop)
    session.commit()
    session.refresh(stop)
    session.add(TripMembership(trip_id=trip.id, user_email=member_email, role=TripRole.owner))
    session.add(PushSubscription(user_email=member_email, endpoint="https://push/1", p256dh="p", auth="a"))
    session.commit()
    return trip, stop


def _flight(session, stop, depart, checkin_window="24h", name="QF1", depart_tz=None):
    details = {"depart_time": depart, "checkin_window": checkin_window}
    if depart_tz:
        details["depart_tz"] = depart_tz
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.flight, name=name, details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _rail(session, stop, depart, name="Eurostar", depart_tz=None):
    details = {"depart_time": depart}
    if depart_tz:
        details["depart_tz"] = depart_tz
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.rail, name=name, details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _fake_sender(calls):
    def sender(info, payload, **kwargs):
        calls.append((info, payload, kwargs))
    return sender


def test_flight_checkin_fires_when_window_open(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    # Departs in 20h, check-in opens 24h before → already open
    _flight(session, stop, (now + timedelta(hours=20)).isoformat(timespec="minutes"), checkin_window="24h")

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 1
    assert len(calls) == 1
    assert "Check-in" in calls[0][1]["title"]


def test_notifications_are_sent_as_urgent(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert calls[0][2] == {"urgent": True}


def test_flight_checkin_not_yet_due(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    # Departs in 30h, check-in opens 24h before → not yet
    _flight(session, stop, (now + timedelta(hours=30)).isoformat(timespec="minutes"), checkin_window="24h")

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 0
    assert calls == []


def test_rail_departure_fires_at_lead_time(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    # Default lead is 3h — departs in 2h → due
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 1
    assert "Departure" in calls[0][1]["title"]


def test_rail_departure_not_yet_due(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=5)).isoformat(timespec="minutes"))

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 0


def test_stale_trigger_is_skipped(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    # Departs in 1h; checkin window is 20h → notify_at was 19h ago, beyond GRACE_HOURS(6)
    _flight(session, stop, (now + timedelta(hours=1)).isoformat(timespec="minutes"), checkin_window="20h")

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 0


def test_already_departed_item_skipped(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now - timedelta(hours=1)).isoformat(timespec="minutes"))
    n = send_due_notifications(session, now=now, sender=_fake_sender([]))
    assert n == 0


def test_missing_checkin_window_skipped(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _flight(session, stop, (now + timedelta(hours=1)).isoformat(timespec="minutes"), checkin_window=None)
    n = send_due_notifications(session, now=now, sender=_fake_sender([]))
    assert n == 0


def test_dedup_across_runs(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    send_due_notifications(session, now=now + timedelta(minutes=15), sender=_fake_sender(calls))
    assert len(calls) == 1   # second run: already logged, not re-sent

    logs = session.exec(select(NotificationLog)).all()
    assert len(logs) == 1


def test_only_trip_members_receive_notification(session):
    trip, stop = _seed_trip(session, member_email="member@x.com")
    # A subscription belonging to someone NOT on this trip
    session.add(PushSubscription(user_email="stranger@x.com", endpoint="https://push/2", p256dh="p", auth="a"))
    session.commit()
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert len(calls) == 1
    assert calls[0][0]["endpoint"] == "https://push/1"


def test_checkin_trigger_accounts_for_flights_departure_timezone(session):
    """Regression test for a real bug: depart_time is stored as LOCAL wall-clock
    time at the departure airport, but the old code compared it directly against
    real UTC `now` with no timezone conversion at all — silently mistreating
    e.g. "14:35 Helsinki time" as if it were "14:35 UTC" (a 3h error in summer).

    Helsinki (Europe/Helsinki) is UTC+3 in July. depart_time "2026-07-02T14:35"
    local → true UTC departure is 2026-07-02T11:35. With a 24h check-in window,
    the TRUE trigger is 2026-07-01T11:35 UTC; the OLD BUGGY trigger would have
    been 2026-07-01T14:35 UTC (using the naive local digits unconverted).
    `now` below sits between those two — due under the fix, not due under the bug.
    """
    trip, stop = _seed_trip(session)
    now = datetime(2026, 7, 1, 12, 0)  # after the correct trigger, before the buggy one
    _flight(session, stop, "2026-07-02T14:35", checkin_window="24h", depart_tz="Europe/Helsinki")

    n = send_due_notifications(session, now=now, sender=_fake_sender([]))
    assert n == 1


def test_checkin_trigger_with_fixed_offset_timezone_matches_iana(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 7, 1, 12, 0)
    _flight(session, stop, "2026-07-02T14:35", checkin_window="24h", depart_tz="+03:00")

    n = send_due_notifications(session, now=now, sender=_fake_sender([]))
    assert n == 1


def test_checkin_trigger_not_yet_due_before_timezone_corrected_time(session):
    """Same flight as above, but `now` is before the TRUE (tz-corrected) trigger
    — must not fire yet, even though it's after the local-clock digits alone
    would suggest under the old buggy interpretation."""
    trip, stop = _seed_trip(session)
    now = datetime(2026, 7, 1, 10, 0)  # before 11:35 UTC true trigger
    _flight(session, stop, "2026-07-02T14:35", checkin_window="24h", depart_tz="Europe/Helsinki")

    n = send_due_notifications(session, now=now, sender=_fake_sender([]))
    assert n == 0


def test_departure_notification_body_shows_local_time_not_utc(session):
    """The notification text must show the flight/train's own local departure
    time (what the traveller sees in the app), not a UTC-shifted value.

    depart_time "2026-07-01T14:35" Helsinki (UTC+3) → true UTC depart 11:35;
    3h lead → notify_at 08:35 UTC. `now` sits between notify_at and the true
    departure, so the trigger is due but the flight hasn't "already left".
    """
    trip, stop = _seed_trip(session)
    now = datetime(2026, 7, 1, 9, 0)
    _rail(session, stop, "2026-07-01T14:35", name="Helsinki express", depart_tz="Europe/Helsinki")

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert "14:35" in calls[0][1]["body"]   # local time, not 11:35 (the UTC equivalent)


def test_expired_subscription_is_deleted(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    def expiring_sender(info, payload, **kwargs):
        raise PushSendError("gone", expired=True)

    send_due_notifications(session, now=now, sender=expiring_sender)
    remaining = session.exec(select(PushSubscription)).all()
    assert remaining == []
