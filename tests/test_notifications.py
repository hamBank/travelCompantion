"""Tests for backend/notifications.py — trigger timing, dedup, and delivery."""
from datetime import datetime, timedelta

import pytest
from sqlmodel import select

from backend.models import (
    Trip, Stop, ItineraryItem, ItemKind, ItemStatus, TripMembership, TripRole,
    PushSubscription, NotificationLog,
)
from backend import notifications as notifications_mod
from backend.notifications import send_due_notifications, send_booking_reminders
from backend.push import PushSendError
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


def _flight(session, stop, depart, checkin_window="24h", name="QF1", depart_tz=None,
            flight_number=None, destination=None):
    details = {"depart_time": depart, "checkin_window": checkin_window}
    if depart_tz:
        details["depart_tz"] = depart_tz
    if flight_number:
        details["flight_number"] = flight_number
    if destination:
        details["destination"] = destination
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.flight, name=name, details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _rail(session, stop, depart, name="Eurostar", depart_tz=None,
          train_number=None, destination=None, origin=None, depart_platform=None):
    details = {"depart_time": depart}
    if depart_tz:
        details["depart_tz"] = depart_tz
    if train_number:
        details["train_number"] = train_number
    if destination:
        details["destination"] = destination
    if origin:
        details["origin"] = origin
    if depart_platform:
        details["depart_platform"] = depart_platform
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.rail, name=name, details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _transfer(session, stop, depart, name="Airport transfer", end_location=None):
    details = {"depart_time": depart}
    if end_location:
        details["end_location"] = end_location
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.transfer, name=name, details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def _bookable(session, stop, kind=ItemKind.activity, name="Museum tickets",
              needs_booking=True, book_by=None, status=ItemStatus.pending):
    details = {}
    if needs_booking:
        details["needs_booking"] = True
    if book_by:
        details["book_by"] = book_by
    item = ItineraryItem(stop_id=stop.id, kind=kind, name=name, details=details, status=status)
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
    # Departs in 20h, check-in opens 24h before → already open (and the
    # heads-up trigger, 20 min earlier still, is also already due).
    _flight(session, stop, (now + timedelta(hours=20)).isoformat(timespec="minutes"), checkin_window="24h")

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 2
    titles = {c[1]["title"] for c in calls}
    assert titles == {"Check-in opening soon", "Check-in now open"}


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


def test_departure_lead_hours_defaults_to_3_with_no_env_var(monkeypatch):
    monkeypatch.delenv("DEPARTURE_LEAD_HOURS", raising=False)
    import importlib
    reloaded = importlib.reload(notifications_mod)
    try:
        assert reloaded.DEPARTURE_LEAD_HOURS == 3.0
    finally:
        importlib.reload(notifications_mod)  # restore for later tests in this process


def test_departure_lead_hours_reads_env_var_at_import(monkeypatch):
    monkeypatch.setenv("DEPARTURE_LEAD_HOURS", "5")
    import importlib
    reloaded = importlib.reload(notifications_mod)
    try:
        assert reloaded.DEPARTURE_LEAD_HOURS == 5.0
    finally:
        monkeypatch.delenv("DEPARTURE_LEAD_HOURS", raising=False)
        importlib.reload(notifications_mod)  # restore the default for later tests


def test_configured_departure_lead_hours_changes_trigger_timing(session, monkeypatch):
    """A wider configured lead time makes a departure due earlier than the
    3h default would allow — exercised via send_due_notifications (imported
    once at module load) rather than the reloaded module, since that's what
    scripts/send_notifications.py actually calls."""
    monkeypatch.setattr(notifications_mod, "DEPARTURE_LEAD_HOURS", 5.0)
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=4)).isoformat(timespec="minutes"))

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 1
    assert "Departure" in calls[0][1]["title"]


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

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert "Check-in now open" in {c[1]["title"] for c in calls}


def test_checkin_trigger_with_fixed_offset_timezone_matches_iana(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 7, 1, 12, 0)
    _flight(session, stop, "2026-07-02T14:35", checkin_window="24h", depart_tz="+03:00")

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert "Check-in now open" in {c[1]["title"] for c in calls}


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


def test_trigger_fires_at_the_correct_real_world_instant_regardless_of_observer_timezone(session):
    """The backend has no notion of "the user's current timezone" at all, by
    design — a check-in opening is a single objective moment in real time
    (UTC); the push simply lands on every subscribed device at that same real
    instant, whatever the local wall-clock time happens to be there. So the
    real thing to validate isn't "does it use the user's timezone" (it
    shouldn't — and doesn't), it's "is the trigger correct in absolute/UTC
    terms," including across a calendar-day boundary between the flight's own
    timezone and some other observer's.

    Tokyo (Asia/Tokyo, UTC+9) flight departs "2026-07-03T09:00" local → true
    UTC depart is 2026-07-03T00:00. With a 24h check-in window, the TRUE
    trigger is 2026-07-02T00:00 UTC.

    For an observer in Los Angeles (UTC-7 in July), that same real instant is
    2026-07-01T17:00 PDT — a full calendar day earlier locally than it is in
    Tokyo (July 1 in LA vs July 2 in Tokyo) — deliberately chosen so a bug
    that leaked any particular local calendar date into the comparison would
    be caught by this test, not just an hour-of-day error.
    """
    trip, stop = _seed_trip(session)
    correct_utc_trigger = datetime(2026, 7, 2, 0, 0)
    _flight(session, stop, "2026-07-03T09:00", checkin_window="24h", depart_tz="Asia/Tokyo")

    # Just before the true UTC trigger — the "now open" alert must NOT fire
    # yet, even though in Tokyo's own local calendar it's already "the 2nd" at
    # this instant. (The heads-up alert, timed 20 min earlier, is already due
    # by this point — that's a separate, correctly-timed trigger, not this bug.)
    calls_before = []
    send_due_notifications(session, now=correct_utc_trigger - timedelta(minutes=1), sender=_fake_sender(calls_before))
    assert "Check-in now open" not in {c[1]["title"] for c in calls_before}

    # At/just after the true UTC trigger — must fire, regardless of what date
    # or hour that is in any other timezone (Tokyo, LA, or anywhere else).
    calls_after = []
    send_due_notifications(session, now=correct_utc_trigger + timedelta(minutes=1), sender=_fake_sender(calls_after))
    assert "Check-in now open" in {c[1]["title"] for c in calls_after}


def test_expired_subscription_is_deleted(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))

    def expiring_sender(info, payload, **kwargs):
        raise PushSendError("gone", expired=True)

    send_due_notifications(session, now=now, sender=expiring_sender)
    remaining = session.exec(select(PushSubscription)).all()
    assert remaining == []


def _call_titled(calls, title):
    return next(c for c in calls if c[1]["title"] == title)


def test_checkin_notification_includes_flight_number_and_destination(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _flight(session, stop, (now + timedelta(hours=20)).isoformat(timespec="minutes"),
            checkin_window="24h", name="Singapore → Helsinki",
            flight_number="AY132", destination="Helsinki")

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    body = _call_titled(calls, "Check-in now open")[1]["body"]
    assert "AY132" in body
    assert "Helsinki" in body
    assert "08:00" in body  # depart time carried through, not just the check-in window


def test_checkin_notification_omits_missing_flight_number_and_destination(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _flight(session, stop, (now + timedelta(hours=20)).isoformat(timespec="minutes"), checkin_window="24h")

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    body = _call_titled(calls, "Check-in now open")[1]["body"]
    assert body == "QF1 at 08:00 — online check-in is open"


def test_checkin_heads_up_fires_before_the_window_opens(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    # Check-in opens in exactly 10 minutes — inside the 20-min heads-up lead,
    # but the window itself is not yet open.
    _flight(session, stop, (now + timedelta(hours=24, minutes=10)).isoformat(timespec="minutes"),
            checkin_window="24h", name="QF1", flight_number="QF1", destination="Singapore")

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 1
    title, body = calls[0][1]["title"], calls[0][1]["body"]
    assert title == "Check-in opening soon"
    assert "QF1" in body
    assert "Singapore" in body
    assert "20 min" in body


def test_checkin_heads_up_not_yet_due_well_before_the_window(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    # Check-in opens in 21 hours — outside even the heads-up lead.
    _flight(session, stop, (now + timedelta(hours=45)).isoformat(timespec="minutes"), checkin_window="24h")

    n = send_due_notifications(session, now=now, sender=_fake_sender([]))
    assert n == 0


def test_checkin_heads_up_and_now_open_are_deduped_independently(session):
    """Each kind is logged separately, so a heads-up already sent doesn't
    block the later "now open" alert, and re-running after both have fired
    sends nothing more."""
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _flight(session, stop, (now + timedelta(hours=24, minutes=10)).isoformat(timespec="minutes"),
            checkin_window="24h")

    calls = []
    n1 = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n1 == 1  # only heads-up is due so far
    assert calls[0][1]["title"] == "Check-in opening soon"

    # 15 minutes later: the window has now opened too.
    n2 = send_due_notifications(session, now=now + timedelta(minutes=15), sender=_fake_sender(calls))
    assert n2 == 1
    assert calls[1][1]["title"] == "Check-in now open"

    # Running again later changes nothing — both kinds already logged.
    n3 = send_due_notifications(session, now=now + timedelta(hours=1), sender=_fake_sender(calls))
    assert n3 == 0


def test_rail_departure_notification_includes_train_number_and_destination(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
          name="Eurostar", train_number="ES9018", destination="Paris")

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    body = calls[0][1]["body"]
    assert "ES9018" in body
    assert "Paris" in body
    assert "14:00" in body


def test_transfer_departure_notification_uses_end_location_as_destination(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _transfer(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
              name="Airport transfer", end_location="Charles de Gaulle Airport")

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    body = calls[0][1]["body"]
    assert "Charles de Gaulle Airport" in body
    assert "14:00" in body


def test_departure_notification_falls_back_when_no_route_details(session):
    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"), name="Eurostar")

    calls = []
    send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert calls[0][1]["body"] == "Eurostar departs at 14:00"


# ── Timezone fallback for items with no depart_tz ────────────────────────────
# Stored depart times are destination-local wall clock. Without a depart_tz
# detail, triggers used to treat them as UTC — on a UTC+8 trip the "departure
# approaching" alert fired ~5h after the train left. The fallback chain is
# depart_tz → stop.timezone column (sheet import) → stop longitude ÷ 15.

def test_rail_without_tz_uses_stop_longitude_offset(session):
    trip, stop = _seed_trip(session)
    stop.lng = "103.82"  # Singapore-ish → approx UTC+7 (round(103.82/15))
    session.add(stop)
    session.commit()
    now = datetime(2026, 8, 1, 12, 0)
    # Wall-clock 21:00 at ~UTC+7 is 14:00 UTC — 2h away, inside the 3h lead →
    # due. Under the old treat-as-UTC reading it was 9h away and NOT due.
    _rail(session, stop, (now + timedelta(hours=9)).isoformat(timespec="minutes"))

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 1
    assert calls[0][1]["title"] == "Departure approaching"


def test_rail_without_tz_prefers_stop_timezone_column_over_longitude(session):
    trip, stop = _seed_trip(session)
    stop.timezone = "8"   # sheet-imported real offset
    stop.lng = "103.82"   # longitude approximation would say +7
    session.add(stop)
    session.commit()
    now = datetime(2026, 8, 1, 12, 0)
    # Wall now+10:30 → UTC now+2:30 under +8 (due, 3h lead) but UTC now+3:30
    # under +7 (not due) — only the timezone-column reading fires.
    _rail(session, stop, (now + timedelta(hours=10, minutes=30)).isoformat(timespec="minutes"))

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 1


def test_explicit_depart_tz_still_wins_over_stop_hints(session):
    trip, stop = _seed_trip(session)
    stop.timezone = "8"
    stop.lng = "103.82"
    session.add(stop)
    session.commit()
    now = datetime(2026, 8, 1, 12, 0)
    # depart_tz says UTC+2: wall now+4h → UTC now+2h → due. Stop hints (+8/+7)
    # would put the departure in the past (skipped) — so firing proves the
    # item's own tz was used.
    _rail(session, stop, (now + timedelta(hours=4)).isoformat(timespec="minutes"), depart_tz="GMT+2")

    calls = []
    n = send_due_notifications(session, now=now, sender=_fake_sender(calls))
    assert n == 1


def test_flight_alert_window_uses_stop_offset_fallback(session):
    from backend.notifications import send_flight_alerts

    trip, stop = _seed_trip(session)
    stop.lng = "103.82"  # approx UTC+7
    session.add(stop)
    session.commit()
    now = datetime(2026, 8, 1, 12, 0)
    # Wall now+26h → UTC now+19h: inside the 24h polling window only once the
    # offset correction is applied (treat-as-UTC put it at 26h → outside).
    _flight(session, stop, (now + timedelta(hours=26)).isoformat(timespec="minutes"),
            checkin_window="24h", flight_number="SQ1")

    fetched = []

    def fake_fetch(flight_iata, day, stored_depart=None):
        fetched.append(flight_iata)
        return None  # no live data — we only care that the window opened

    send_flight_alerts(session, now=now, sender=_fake_sender([]), fetch=fake_fetch)
    assert fetched == ["SQ1"]


# ── send_rail_alerts — live delay/cancellation/platform-change polling ───────
# Mirrors the send_flight_alerts tests above as closely as the rail data
# source (backend/rail_live.py, wrapping the free transport.rest API) allows:
# same window/poll-gap/dedup shape, but cancelled/delay/platform fields
# instead of AeroDataBox's status/movement/gate ones.

def test_rail_alert_window_uses_stop_offset_fallback(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    stop.lng = "103.82"  # approx UTC+7
    session.add(stop)
    session.commit()
    now = datetime(2026, 8, 1, 12, 0)
    # Wall now+26h → UTC now+19h: inside the 24h polling window only once the
    # offset correction is applied (treat-as-UTC put it at 26h → outside).
    _rail(session, stop, (now + timedelta(hours=26)).isoformat(timespec="minutes"),
          train_number="ICE123", origin="Singapore")

    fetched = []

    def fake_fetch(train_number, origin, dep_time):
        fetched.append(train_number)
        return None  # no live data — we only care that the window opened

    send_rail_alerts(session, now=now, sender=_fake_sender([]), fetch=fake_fetch)
    assert fetched == ["ICE123"]


def test_rail_alert_not_polled_outside_window(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    # Departs in 30h — outside the default 24h alert window.
    _rail(session, stop, (now + timedelta(hours=30)).isoformat(timespec="minutes"),
          train_number="ICE123", origin="Berlin")

    fetched = []

    def fake_fetch(train_number, origin, dep_time):
        fetched.append(train_number)
        return None

    send_rail_alerts(session, now=now, sender=_fake_sender([]), fetch=fake_fetch)
    assert fetched == []


def test_rail_alert_skipped_without_origin_or_train_number(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"))  # no train_number/origin

    fetched = []

    def fake_fetch(train_number, origin, dep_time):
        fetched.append(train_number)
        return None

    n = send_rail_alerts(session, now=now, sender=_fake_sender([]), fetch=fake_fetch)
    assert n == 0
    assert fetched == []


def test_rail_cancellation_alert(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
          name="Eurostar", train_number="ES9018", origin="London", destination="Paris")

    def fake_fetch(train_number, origin, dep_time):
        return {"cancelled": True, "when": None, "plannedWhen": "2026-08-01T14:00:00+01:00"}

    calls = []
    n = send_rail_alerts(session, now=now, sender=_fake_sender(calls), fetch=fake_fetch)
    assert n == 1
    assert calls[0][1]["title"] == "Train cancelled"
    assert "ES9018" in calls[0][1]["body"]

    logs = session.exec(select(NotificationLog)).all()
    assert [(log.item_id, log.kind) for log in logs] == [(logs[0].item_id, "rail_cancel")]


def test_rail_delay_bucket_fires_once_and_escalates(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
          name="Eurostar", train_number="ES9018", origin="London", destination="Paris")

    calls = []

    def fake_fetch_20min_late(train_number, origin, dep_time):
        return {
            "cancelled": False,
            "plannedWhen": "2026-08-01T14:00:00+00:00",
            "when": "2026-08-01T14:20:00+00:00",  # 20 min late → clears the 15-min bucket
        }

    n1 = send_rail_alerts(session, now=now, sender=_fake_sender(calls), fetch=fake_fetch_20min_late)
    assert n1 == 1
    assert calls[0][1]["title"] == "Train delayed"
    assert "20m" in calls[0][1]["body"]  # actual delay, not the bucket threshold

    # Re-polling immediately (within the poll gap) shouldn't call fetch again,
    # let alone re-send the same bucket.
    n_throttled = send_rail_alerts(session, now=now + timedelta(minutes=5),
                                    sender=_fake_sender(calls), fetch=fake_fetch_20min_late)
    assert n_throttled == 0
    assert len(calls) == 1

    # Past the poll gap, still 20 min late — same bucket, must not re-fire.
    n2 = send_rail_alerts(session, now=now + timedelta(minutes=31),
                           sender=_fake_sender(calls), fetch=fake_fetch_20min_late)
    assert n2 == 0
    assert len(calls) == 1

    def fake_fetch_45min_late(train_number, origin, dep_time):
        return {
            "cancelled": False,
            "plannedWhen": "2026-08-01T14:00:00+00:00",
            "when": "2026-08-01T14:45:00+00:00",  # now 45 min late → clears the 30-min bucket too
        }

    n3 = send_rail_alerts(session, now=now + timedelta(minutes=65),
                           sender=_fake_sender(calls), fetch=fake_fetch_45min_late)
    assert n3 == 1
    assert len(calls) == 2
    assert calls[1][1]["title"] == "Train delayed"
    assert "45m" in calls[1][1]["body"]  # actual delay, not the bucket threshold

    logs = session.exec(select(NotificationLog)).all()
    kinds = {log.kind for log in logs}
    assert kinds == {"rail_delay:15", "rail_delay:30"}


def test_rail_platform_change_alert(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
          name="Eurostar", train_number="ES9018", origin="London", destination="Paris",
          depart_platform="4")

    def fake_fetch(train_number, origin, dep_time):
        return {
            "cancelled": False,
            "plannedWhen": "2026-08-01T14:00:00+00:00",
            "when": "2026-08-01T14:00:00+00:00",  # on time, no delay alert
            "platform": "9",
        }

    calls = []
    n = send_rail_alerts(session, now=now, sender=_fake_sender(calls), fetch=fake_fetch)
    assert n == 1
    assert calls[0][1]["title"] == "Platform changed"
    assert "4" in calls[0][1]["body"] and "9" in calls[0][1]["body"]

    logs = session.exec(select(NotificationLog)).all()
    assert [log.kind for log in logs] == ["rail_platform:9"]


def test_rail_no_platform_alert_when_unchanged(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
          name="Eurostar", train_number="ES9018", origin="London", destination="Paris",
          depart_platform="4")

    def fake_fetch(train_number, origin, dep_time):
        return {
            "cancelled": False,
            "plannedWhen": "2026-08-01T14:00:00+00:00",
            "when": "2026-08-01T14:00:00+00:00",
            "platform": "4",  # unchanged
        }

    n = send_rail_alerts(session, now=now, sender=_fake_sender([]), fetch=fake_fetch)
    assert n == 0


def test_rail_alert_poll_throttled_across_runs(session):
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
          train_number="ICE123", origin="Berlin")

    fetched = []

    def fake_fetch(train_number, origin, dep_time):
        fetched.append(now)
        return None

    send_rail_alerts(session, now=now, sender=_fake_sender([]), fetch=fake_fetch)
    # Same poll gap (30 min default) not yet elapsed — must not call fetch again.
    send_rail_alerts(session, now=now + timedelta(minutes=10), sender=_fake_sender([]), fetch=fake_fetch)
    assert len(fetched) == 1

    # Past the poll gap — fetch is attempted again.
    send_rail_alerts(session, now=now + timedelta(minutes=31), sender=_fake_sender([]), fetch=fake_fetch)
    assert len(fetched) == 2


def test_rail_alert_idempotent_same_bucket_not_resent_after_poll_gap(session):
    """Re-polling after the poll gap with the same (unescalated) delay must
    not re-send the already-logged bucket, even though fetch runs again."""
    from backend.notifications import send_rail_alerts

    trip, stop = _seed_trip(session)
    now = datetime(2026, 8, 1, 12, 0)
    _rail(session, stop, (now + timedelta(hours=2)).isoformat(timespec="minutes"),
          name="Eurostar", train_number="ES9018", origin="London", destination="Paris")

    def fake_fetch(train_number, origin, dep_time):
        return {
            "cancelled": False,
            "plannedWhen": "2026-08-01T14:00:00+00:00",
            "when": "2026-08-01T14:20:00+00:00",
        }

    calls = []
    n1 = send_rail_alerts(session, now=now, sender=_fake_sender(calls), fetch=fake_fetch)
    assert n1 == 1

    n2 = send_rail_alerts(session, now=now + timedelta(minutes=31), sender=_fake_sender(calls), fetch=fake_fetch)
    assert n2 == 0
    assert len(calls) == 1
# ── send_booking_reminders — needs_booking / book_by deadline reminders ──────
# Unlike the transport triggers above, these apply to ANY item kind (the
# frontend's "Needs booking" row is shared chrome every kind's edit form
# gets, not a per-kind field) — _bookable above defaults to a plain
# "activity" item to make that point.

def test_booking_due_fires_at_9am_destination_local_and_is_idempotent(session):
    trip, stop = _seed_trip(session)
    # No stop timezone/lng hints → offset falls back to UTC, so 09:00
    # destination-local is 09:00 UTC.
    _bookable(session, stop, book_by="2026-08-05")

    calls = []
    n = send_booking_reminders(session, now=datetime(2026, 8, 5, 9, 0), sender=_fake_sender(calls))
    assert n == 1
    assert calls[0][1]["title"] == "Booking deadline"
    assert "Museum tickets" in calls[0][1]["body"]

    # Re-running at/after the same instant must not re-send.
    n2 = send_booking_reminders(session, now=datetime(2026, 8, 5, 10, 0), sender=_fake_sender(calls))
    assert n2 == 0
    assert len(calls) == 1


def test_booking_soon_fires_seven_days_before_the_due_date(session):
    trip, stop = _seed_trip(session)
    _bookable(session, stop, book_by="2026-08-12")  # 7 days after Aug 5

    calls = []
    n = send_booking_reminders(session, now=datetime(2026, 8, 5, 9, 0), sender=_fake_sender(calls))
    assert n == 1
    assert calls[0][1]["title"] == "Booking deadline approaching"
    assert "one week" in calls[0][1]["body"]

    # The "due today" trigger for Aug 12 isn't due yet.
    n2 = send_booking_reminders(session, now=datetime(2026, 8, 5, 10, 0), sender=_fake_sender(calls))
    assert n2 == 0


def test_unchecked_needs_booking_does_not_fire(session):
    """A leftover book_by with needs_booking now false/absent — e.g. the user
    unchecked the box — must not fire. (The frontend clears book_by too when
    unchecking, but the backend doesn't rely on that.)"""
    trip, stop = _seed_trip(session)
    _bookable(session, stop, needs_booking=False, book_by="2026-08-05")

    n = send_booking_reminders(session, now=datetime(2026, 8, 5, 9, 0), sender=_fake_sender([]))
    assert n == 0


def test_done_item_does_not_fire(session):
    trip, stop = _seed_trip(session)
    _bookable(session, stop, book_by="2026-08-05", status=ItemStatus.done)

    n = send_booking_reminders(session, now=datetime(2026, 8, 5, 9, 0), sender=_fake_sender([]))
    assert n == 0


def test_skipped_item_does_not_fire(session):
    trip, stop = _seed_trip(session)
    _bookable(session, stop, book_by="2026-08-05", status=ItemStatus.skipped)

    n = send_booking_reminders(session, now=datetime(2026, 8, 5, 9, 0), sender=_fake_sender([]))
    assert n == 0


def test_stale_booking_trigger_is_skipped(session):
    trip, stop = _seed_trip(session)
    _bookable(session, stop, book_by="2026-08-01")  # due trigger was 09:00 Aug 1

    # Two days after the due trigger — well beyond GRACE_HOURS(6).
    n = send_booking_reminders(session, now=datetime(2026, 8, 3, 9, 0), sender=_fake_sender([]))
    assert n == 0


def test_stop_offset_affects_booking_trigger_instant(session):
    """Regression-style test mirroring test_rail_without_tz_uses_stop_longitude_offset:
    book_by has no timezone of its own, so the trigger must use the stop's
    offset (here, longitude-approximated) rather than silently treating
    09:00 destination-local as if it were 09:00 UTC."""
    trip, stop = _seed_trip(session)
    stop.lng = "103.82"  # Singapore-ish → approx UTC+7
    session.add(stop)
    session.commit()
    _bookable(session, stop, book_by="2026-08-05")

    # Just before the true (offset-corrected) trigger instant (09:00 local ==
    # 02:00 UTC at UTC+7) — not due yet.
    n_before = send_booking_reminders(session, now=datetime(2026, 8, 5, 1, 59), sender=_fake_sender([]))
    assert n_before == 0

    # At the true trigger instant — due. Under a treat-as-UTC bug this would
    # still be 7 hours away and wrongly not fire.
    calls = []
    n = send_booking_reminders(session, now=datetime(2026, 8, 5, 2, 0), sender=_fake_sender(calls))
    assert n == 1
    assert calls[0][1]["title"] == "Booking deadline"
