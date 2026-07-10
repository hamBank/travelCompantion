"""Tests for backend/notifications.py:send_flight_alerts — live-polled flight
delay/cancellation/gate-change push alerts, distinct from the schedule-based
triggers in test_notifications.py."""
from datetime import datetime, timedelta

import pytest

from backend.models import Trip, Stop, ItineraryItem, ItemKind, TripMembership, TripRole, PushSubscription
from backend.notifications import send_flight_alerts
from backend.flight_live import FlightLiveError
from tests.conftest import make_test_session


@pytest.fixture
def session():
    with make_test_session() as s:
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


def _flight(session, stop, depart, flight_number="QF1469", origin="CBR",
            destination="MEL", origin_gate=None, depart_tz=None):
    details = {"depart_time": depart, "flight_number": flight_number,
               "origin": origin, "destination": destination}
    if origin_gate:
        details["origin_gate"] = origin_gate
    if depart_tz:
        details["depart_tz"] = depart_tz
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.flight, name="Flight", details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _fake_sender(calls):
    def sender(info, payload, **kwargs):
        calls.append((info, payload, kwargs))
    return sender


def _fake_fetch(live, calls=None):
    def fetch(flight_iata, dep_date):
        if calls is not None:
            calls.append((flight_iata, dep_date))
        return live
    return fetch


def _live(status="Expected", dep_overrides=None):
    departure = {
        "scheduledTime": {"utc": "2026-08-01 12:00", "local": "2026-08-01 12:00+00:00"},
    }
    if dep_overrides:
        departure.update(dep_overrides)
    return {"status": status, "departure": departure}


def test_flight_outside_window_is_never_fetched(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    _flight(session, stop, (now + timedelta(hours=48)).isoformat(timespec="minutes"))

    calls = []
    n = send_flight_alerts(session, now=now, sender=_fake_sender([]), fetch=_fake_fetch(_live(), calls))
    assert n == 0
    assert calls == []


def test_delay_45m_sends_one_alert_bucketed_at_30(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    live = _live(dep_overrides={"revisedTime": {"utc": "2026-08-01 12:45", "local": "2026-08-01 12:45+00:00"}})
    calls = []
    n = send_flight_alerts(session, now=now, sender=_fake_sender(calls), fetch=_fake_fetch(live))
    assert n == 1
    assert calls[0][1]["title"] == "Flight delayed"
    assert "45m late" in calls[0][1]["body"]

    # Re-run right away — logged, so no resend even without the poll throttle.
    n2 = send_flight_alerts(session, now=now, sender=_fake_sender(calls), fetch=_fake_fetch(live))
    assert n2 == 0
    assert len(calls) == 1


def test_delay_growing_from_45_to_70_sends_a_new_higher_bucket_alert(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    live_45 = _live(dep_overrides={"revisedTime": {"utc": "2026-08-01 12:45", "local": "2026-08-01 12:45+00:00"}})
    calls = []
    send_flight_alerts(session, now=now, sender=_fake_sender(calls), fetch=_fake_fetch(live_45))
    assert len(calls) == 1

    # Later poll (past the throttle window) shows the delay has grown to 70m.
    later = now + timedelta(minutes=50)
    live_70 = _live(dep_overrides={"revisedTime": {"utc": "2026-08-01 13:10", "local": "2026-08-01 13:10+00:00"}})
    n = send_flight_alerts(session, now=later, sender=_fake_sender(calls), fetch=_fake_fetch(live_70))
    assert n == 1
    assert len(calls) == 2
    assert "1h 10m late" in calls[1][1]["body"]


def test_cancelled_status_sends_cancellation_alert_once(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    live = _live(status="Canceled")
    calls = []
    n = send_flight_alerts(session, now=now, sender=_fake_sender(calls), fetch=_fake_fetch(live))
    assert n == 1
    assert calls[0][1]["title"] == "Flight cancelled"

    n2 = send_flight_alerts(session, now=now, sender=_fake_sender(calls), fetch=_fake_fetch(live))
    assert n2 == 0


def test_gate_change_detected_only_when_a_gate_was_stored(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    item = _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"), origin_gate="D12")

    live = _live(dep_overrides={"gate": "D15"})
    calls = []
    n = send_flight_alerts(session, now=now, sender=_fake_sender(calls), fetch=_fake_fetch(live))
    assert n == 1
    assert calls[0][1]["title"] == "Gate changed"
    assert "D12" in calls[0][1]["body"] and "D15" in calls[0][1]["body"]


def test_no_gate_alert_when_nothing_was_stored(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))  # no origin_gate

    live = _live(dep_overrides={"gate": "D15"})
    n = send_flight_alerts(session, now=now, sender=_fake_sender([]), fetch=_fake_fetch(live))
    assert n == 0


def test_throttle_skips_fetch_within_poll_window(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    calls = []
    send_flight_alerts(session, now=now, sender=_fake_sender([]), fetch=_fake_fetch(_live(), calls))
    assert len(calls) == 1

    # Same flight, 10 minutes later — well inside the default 45-minute gap.
    send_flight_alerts(session, now=now + timedelta(minutes=10), sender=_fake_sender([]), fetch=_fake_fetch(_live(), calls))
    assert len(calls) == 1  # not fetched again


def test_one_flights_fetch_error_does_not_stop_the_run(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 0, 0)
    _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"), flight_number="AA1")
    _flight(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"), flight_number="AA2")

    def fetch(flight_iata, dep_date):
        if flight_iata == "AA1":
            raise FlightLiveError("boom")
        return _live(status="Canceled")

    calls = []
    n = send_flight_alerts(session, now=now, sender=_fake_sender(calls), fetch=fetch)
    assert n == 1
    assert calls[0][1]["title"] == "Flight cancelled"
