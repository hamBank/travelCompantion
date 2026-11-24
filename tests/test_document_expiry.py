"""Tests for backend/notifications.py's send_document_expiry_reminders
(plan-12b) — the UserDocument.expiry_date -> push-notification trigger.

Modeled on tests/test_notifications.py and tests/test_flight_alerts.py.
"""
from datetime import datetime, timedelta

import pytest
from sqlmodel import select

from backend.models import Trip, TripMembership, TripRole, PushSubscription, UserDocument, Traveler
from backend.notifications import send_document_expiry_reminders, send_due_notifications
from backend.push import PushSendError
from tests.conftest import make_test_session


@pytest.fixture
def session():
    with make_test_session() as s:
        yield s


def _member(session, email, trip, role=TripRole.owner):
    session.add(TripMembership(trip_id=trip.id, user_email=email, role=role))
    existing = session.exec(select(PushSubscription).where(PushSubscription.user_email == email)).first()
    if not existing:
        session.add(PushSubscription(user_email=email, endpoint=f"https://push/{email}", p256dh="p", auth="a"))
    session.commit()


def _trip(session, name="Trip", end_date=None):
    trip = Trip(name=name, end_date=end_date)
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return trip


def _doc(session, email, expiry_date=None, label="US Passport", doc_type="passport"):
    doc = UserDocument(user_email=email, doc_type=doc_type, label=label, expiry_date=expiry_date)
    session.add(doc)
    session.commit()
    session.refresh(doc)
    return doc


NOW = datetime(2026, 1, 1)


def _sender():
    sent = []

    def sender(info, payload, urgent=False):
        sent.append((info, payload))

    return sent, sender


def test_document_expiring_within_window_sends_one_reminder_and_dedupes(session):
    trip = _trip(session, name="Japan trip", end_date=NOW + timedelta(days=100))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=NOW + timedelta(days=120))

    sent, sender = _sender()
    n = send_document_expiry_reminders(session, now=NOW, sender=sender)
    assert n == 1
    assert len(sent) == 1
    assert "US Passport" in sent[0][1]["body"]
    assert "Japan trip" in sent[0][1]["body"]

    # Re-run — no resend.
    sent2, sender2 = _sender()
    n2 = send_document_expiry_reminders(session, now=NOW, sender=sender2)
    assert n2 == 0
    assert sent2 == []


def test_document_with_no_expiry_date_never_fires(session):
    trip = _trip(session, end_date=NOW + timedelta(days=50))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=None)

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 0
    assert sent == []


def test_trip_ending_more_than_six_months_before_expiry_no_fire(session):
    trip = _trip(session, end_date=NOW + timedelta(days=10))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=NOW + timedelta(days=300))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 0
    assert sent == []


def test_expired_document_with_trip_before_expiry_but_outside_window_no_fire(session):
    # Document already expired relative to `now`; the trip ends before that
    # expiry, but well outside the 6-month lookahead -- not a match.
    trip = _trip(session, end_date=NOW - timedelta(days=400))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=NOW - timedelta(days=30))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 0
    assert sent == []


def test_two_trips_in_window_sends_exactly_one_for_the_earliest(session):
    trip1 = _trip(session, name="Early trip", end_date=NOW + timedelta(days=30))
    trip2 = _trip(session, name="Later trip", end_date=NOW + timedelta(days=60))
    _member(session, "a@x.com", trip1)
    _member(session, "a@x.com", trip2)
    _doc(session, "a@x.com", expiry_date=NOW + timedelta(days=90))

    sent, sender = _sender()
    n = send_document_expiry_reminders(session, now=NOW, sender=sender)
    assert n == 1
    assert len(sent) == 1
    assert "Early trip" in sent[0][1]["body"]


def test_two_users_documents_dont_cross_fire(session):
    trip_a = _trip(session, name="A's trip", end_date=NOW + timedelta(days=30))
    trip_b = _trip(session, name="B's trip", end_date=NOW + timedelta(days=1000))  # never matches
    _member(session, "a@x.com", trip_a)
    _member(session, "b@x.com", trip_b)
    _doc(session, "a@x.com", expiry_date=NOW + timedelta(days=60))
    _doc(session, "b@x.com", expiry_date=NOW + timedelta(days=60))

    sent, sender = _sender()
    n = send_document_expiry_reminders(session, now=NOW, sender=sender)
    assert n == 1
    assert "A's trip" in sent[0][1]["body"]


def test_expired_push_subscription_is_cleaned_up(session):
    trip = _trip(session, end_date=NOW + timedelta(days=30))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=NOW + timedelta(days=60))

    def failing_sender(info, payload, urgent=False):
        raise PushSendError("gone", expired=True)

    send_document_expiry_reminders(session, now=NOW, sender=failing_sender)
    remaining = session.exec(
        select(PushSubscription).where(PushSubscription.user_email == "a@x.com")
    ).all()
    assert remaining == []


def test_send_due_notifications_unaffected(session):
    """Regression: this trigger doesn't interfere with the existing one."""
    trip = _trip(session, end_date=NOW + timedelta(days=30))
    _member(session, "a@x.com", trip)
    assert send_due_notifications(session, now=NOW) == 0


def _traveler(session, trip, name, email=None):
    session.add(Traveler(trip_id=trip.id, display_name=name, user_email=email))
    session.commit()


def test_body_says_the_passport_outlasts_the_trip_not_that_it_expires_before(session):
    # Reported: a passport expiring 2027-06-28 alerted for a trip ending
    # 2027-03-22 with text claiming it expired "before your trip ends". It
    # expires 98 days AFTER; the reason to warn is the 6-month-validity rule.
    now = datetime(2026, 11, 24)
    trip = _trip(session, name="Spring trip", end_date=datetime(2027, 3, 22))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=datetime(2027, 6, 28))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=now, sender=sender) == 1
    body = sent[0][1]["body"]
    assert "98 days after your trip ends" in body
    assert "Spring trip" in body and "Mar 22, 2027" in body
    assert "before your trip" not in body
    assert "6 months" in body


def test_member_who_is_not_a_traveler_gets_no_reminder(session):
    trip = _trip(session, end_date=NOW + timedelta(days=30))
    _member(session, "partner@x.com", trip, role=TripRole.editor)
    _member(session, "me@x.com", trip)
    _traveler(session, trip, "Me", "me@x.com")           # trip lists travelers; partner isn't one
    _doc(session, "partner@x.com", expiry_date=NOW + timedelta(days=60))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 0
    assert sent == []


def test_member_who_is_a_traveler_still_gets_the_reminder(session):
    trip = _trip(session, end_date=NOW + timedelta(days=30))
    _member(session, "me@x.com", trip)
    _traveler(session, trip, "Me", "ME@x.com")            # case-insensitive match
    _doc(session, "me@x.com", expiry_date=NOW + timedelta(days=60))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 1


def test_trip_with_no_travelers_recorded_falls_back_to_membership(session):
    trip = _trip(session, end_date=NOW + timedelta(days=30))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=NOW + timedelta(days=60))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 1


def test_trip_that_already_ended_gets_no_reminder(session):
    trip = _trip(session, end_date=NOW - timedelta(days=10))
    _member(session, "a@x.com", trip)
    _doc(session, "a@x.com", expiry_date=NOW + timedelta(days=60))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 0


def test_only_the_document_owner_is_notified_not_other_trip_members(session):
    trip = _trip(session, end_date=NOW + timedelta(days=30))
    _member(session, "owner@x.com", trip)
    _member(session, "other@x.com", trip, role=TripRole.editor)
    _doc(session, "owner@x.com", expiry_date=NOW + timedelta(days=60))

    sent, sender = _sender()
    assert send_document_expiry_reminders(session, now=NOW, sender=sender) == 1
    assert [info["endpoint"] for info, _ in sent] == ["https://push/owner@x.com"]
