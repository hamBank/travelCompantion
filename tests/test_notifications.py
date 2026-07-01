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


def _flight(session, stop, depart, checkin_window="24h", name="QF1"):
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.flight, name=name,
                         details={"depart_time": depart, "checkin_window": checkin_window})
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _rail(session, stop, depart, name="Eurostar"):
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.rail, name=name,
                         details={"depart_time": depart})
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _fake_sender(calls):
    def sender(info, payload):
        calls.append((info, payload))
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


def test_expired_subscription_is_deleted(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    def expiring_sender(info, payload):
        raise PushSendError("gone", expired=True)

    send_due_notifications(session, now=now, sender=expiring_sender)
    remaining = session.exec(select(PushSubscription)).all()
    assert remaining == []
