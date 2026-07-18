"""Tests for plan-14: AeroDataBox webhook subscriptions, the reconciler, the
/webhooks/aerodatabox/{secret} receiver, and the polling fallback skip."""
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import flight_alert_subscriptions as fas
from backend.models import (
    Trip, Stop, ItineraryItem, ItemKind, TripMembership, TripRole,
    PushSubscription, NotificationLog,
)
from backend.notifications import send_flight_alerts
from tests.conftest import make_test_session

NOW = datetime(2026, 8, 1, 12, 0)


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


def _flight(session, stop, depart, flight_number="KL1395", details_extra=None):
    details = {"depart_time": depart, "flight_number": flight_number,
               "depart_tz": "GMT+0", **(details_extra or {})}
    item = ItineraryItem(stop_id=stop.id, kind=ItemKind.flight, name=flight_number, details=details)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text if text or json_data is None else "x"

    def json(self):
        return self._json


class FakeApi:
    """Records subscription API calls and plays back canned behavior."""

    def __init__(self, balance=100, existing=None, airports=None, feed_status=None):
        self.balance = balance
        self.existing = list(existing or [])
        self.calls = []
        self._next_id = 0
        # iata -> icao, and icao -> liveFlightUpdatesFeed status string
        self.airports = airports or {}
        self.feed_status = feed_status or {}

    def __call__(self, method, path, json_body=None):
        self.calls.append((method, path, json_body))
        if method == "POST" and path.startswith("/subscriptions/webhook/FlightByNumber/"):
            self._next_id += 1
            sub = {"id": f"sub-{self._next_id}", "isActive": self.balance > 0}
            self.existing.append(sub)
            return FakeResponse(200, sub)
        if method == "GET" and path == "/subscriptions/webhook":
            if not self.existing:
                return FakeResponse(204, None, text="")
            return FakeResponse(200, list(self.existing))
        if method == "DELETE" and path.startswith("/subscriptions/webhook/"):
            sub_id = path.rsplit("/", 1)[1]
            self.existing = [s for s in self.existing if s["id"] != sub_id]
            return FakeResponse(200, {})
        if method == "GET" and path == "/subscriptions/balance":
            if self.balance == 0:
                return FakeResponse(200, None, text="")  # observed live: empty body when never refilled
            return FakeResponse(200, {"creditsRemaining": self.balance})
        if method == "POST" and path == "/subscriptions/balance/refill":
            self.balance += json_body["credits"]
            return FakeResponse(200, {"creditsRemaining": self.balance})
        if method == "GET" and path.startswith("/airports/Iata/"):
            iata = path.rsplit("/", 1)[1]
            return FakeResponse(200, {"icao": self.airports.get(iata)})
        if method == "GET" and path.startswith("/health/services/airports/") and path.endswith("/feeds"):
            icao = path.split("/")[4]
            status = self.feed_status.get(icao, "OK")
            return FakeResponse(200, {"liveFlightUpdatesFeed": {"status": status}})
        raise AssertionError(f"unexpected call {method} {path}")


# ── client parsing ────────────────────────────────────────────────────────────

def test_list_subscriptions_204_is_empty_list():
    api = FakeApi(existing=[])
    assert fas.list_subscriptions(request=api) == []


def test_get_balance_empty_body_is_zero():
    api = FakeApi(balance=0)
    assert fas.get_balance(request=api) == 0


def test_get_balance_parses_credits():
    api = FakeApi(balance=42)
    assert fas.get_balance(request=api) == 42


# ── reconciler ────────────────────────────────────────────────────────────────

def test_reconcile_subscribes_in_window_flight_and_stores_id(session, monkeypatch):
    monkeypatch.setattr(fas, "WEBHOOK_SECRET", "s3cret")
    monkeypatch.setattr(fas, "PUBLIC_BASE_URL", "https://example.test")
    _, stop = _seed_trip(session)
    item = _flight(session, stop, (NOW + timedelta(hours=10)).isoformat())

    api = FakeApi(balance=100)
    summary = fas.reconcile_subscriptions(session, now=NOW, request=api)

    assert summary["subscribed"] == 1
    session.refresh(item)
    assert item.details["alert_subscription_id"] == "sub-1"
    create_calls = [c for c in api.calls if c[0] == "POST" and "FlightByNumber" in c[1]]
    assert create_calls[0][1].endswith("/KL1395")
    assert create_calls[0][2]["url"] == "https://example.test/webhooks/aerodatabox/s3cret"
    assert create_calls[0][2]["maxDeliveryRetries"] == 0


def test_reconcile_skips_out_of_window_flights(session):
    _, stop = _seed_trip(session)
    _flight(session, stop, (NOW + timedelta(hours=100)).isoformat())   # beyond 72h
    _flight(session, stop, (NOW - timedelta(hours=2)).isoformat(), flight_number="QF2")  # departed

    api = FakeApi(balance=100)
    summary = fas.reconcile_subscriptions(session, now=NOW, request=api)
    assert summary["subscribed"] == 0


def test_reconcile_removes_stale_subscription_and_clears_id(session):
    _, stop = _seed_trip(session)
    departed = _flight(session, stop, (NOW - timedelta(hours=8)).isoformat(),
                       details_extra={"alert_subscription_id": "sub-old"})

    api = FakeApi(balance=100, existing=[{"id": "sub-old"}])
    summary = fas.reconcile_subscriptions(session, now=NOW, request=api)

    assert summary["unsubscribed"] == 1
    assert api.existing == []
    session.refresh(departed)
    assert "alert_subscription_id" not in departed.details


def test_reconcile_refills_when_below_floor(session):
    _, stop = _seed_trip(session)
    api = FakeApi(balance=0)
    summary = fas.reconcile_subscriptions(session, now=NOW, request=api)
    assert summary["refilled"] == fas.CREDIT_REFILL
    assert summary["credits"] == fas.CREDIT_REFILL


def test_reconcile_failed_create_leaves_no_id_so_polling_covers_it(session, monkeypatch):
    _, stop = _seed_trip(session)
    item = _flight(session, stop, (NOW + timedelta(hours=10)).isoformat())

    def failing_request(method, path, json_body=None):
        if "FlightByNumber" in path:
            raise fas.FlightAlertApiError("boom")
        return FakeApi(balance=100)(method, path, json_body)

    summary = fas.reconcile_subscriptions(session, now=NOW, request=failing_request)
    assert summary["subscribed"] == 0
    session.refresh(item)
    assert "alert_subscription_id" not in (item.details or {})


# ── airport coverage ──────────────────────────────────────────────────────────

def test_resolve_icao_maps_iata_to_icao():
    api = FakeApi(airports={"FCO": "LIRF"})
    assert fas.resolve_icao("FCO", request=api) == "LIRF"


def test_check_live_updates_ok_true_for_ok_status():
    api = FakeApi(feed_status={"LIRF": "OK"})
    assert fas.check_live_updates_ok("LIRF", request=api) is True


def test_check_live_updates_ok_false_when_down():
    api = FakeApi(feed_status={"LIRF": "Down"})
    assert fas.check_live_updates_ok("LIRF", request=api) is False


def test_check_live_updates_ok_false_when_unavailable():
    api = FakeApi(feed_status={"LIRF": "Unavailable"})
    assert fas.check_live_updates_ok("LIRF", request=api) is False


def test_check_live_updates_ok_true_for_partial_and_degraded_and_unknown():
    for status in ("OKPartial", "Degraded", "Unknown"):
        api = FakeApi(feed_status={"LIRF": status})
        assert fas.check_live_updates_ok("LIRF", request=api) is True, status


def test_get_coverage_caches_result(session):
    api = FakeApi(airports={"FCO": "LIRF"}, feed_status={"LIRF": "Down"})
    assert fas.get_coverage(session, "FCO", request=api) is False
    icao_calls = [c for c in api.calls if c[1].startswith("/airports/")]
    feed_calls = [c for c in api.calls if "/feeds" in c[1]]
    assert len(icao_calls) == 1 and len(feed_calls) == 1

    # Second call within the recheck window hits neither endpoint again.
    assert fas.get_coverage(session, "FCO", request=api) is False
    assert len(api.calls) == 2  # unchanged


def test_get_coverage_rechecks_feed_status_but_not_icao_after_ttl(session):
    from backend.models import AirportCoverage
    api = FakeApi(airports={"FCO": "LIRF"}, feed_status={"LIRF": "OK"})
    stale = NOW - timedelta(days=fas.COVERAGE_RECHECK_DAYS + 1)
    session.add(AirportCoverage(iata="FCO", icao="LIRF", live_updates_ok=False, checked_at=stale))
    session.commit()

    assert fas.get_coverage(session, "FCO", now=NOW, request=api) is True  # flipped since last check
    icao_calls = [c for c in api.calls if c[1].startswith("/airports/")]
    assert icao_calls == []  # icao already known — not re-resolved


def test_get_coverage_defaults_true_when_icao_unresolvable(session):
    api = FakeApi(airports={})  # FCO not in the map -> icao stays None
    assert fas.get_coverage(session, "FCO", request=api) is True


def test_reconcile_skips_subscribing_when_origin_has_no_live_coverage(session):
    _, stop = _seed_trip(session)
    item = _flight(session, stop, (NOW + timedelta(hours=10)).isoformat(),
                   details_extra={"origin": "FCO"})

    api = FakeApi(balance=100, airports={"FCO": "LIRF"}, feed_status={"LIRF": "Down"})
    summary = fas.reconcile_subscriptions(session, now=NOW, request=api)

    assert summary["subscribed"] == 0
    assert summary["no_coverage"] == 1
    session.refresh(item)
    assert "alert_subscription_id" not in item.details
    create_calls = [c for c in api.calls if "FlightByNumber" in c[1]]
    assert create_calls == []


def test_reconcile_subscribes_when_origin_has_coverage(session):
    _, stop = _seed_trip(session)
    item = _flight(session, stop, (NOW + timedelta(hours=10)).isoformat(),
                   details_extra={"origin": "ZRH"})

    api = FakeApi(balance=100, airports={"ZRH": "LSZH"}, feed_status={"LSZH": "OK"})
    summary = fas.reconcile_subscriptions(session, now=NOW, request=api)

    assert summary["subscribed"] == 1
    assert summary["no_coverage"] == 0


def test_reconcile_subscribes_when_flight_has_no_origin_field(session):
    # No coverage info available at all — don't block on missing data.
    _, stop = _seed_trip(session)
    item = _flight(session, stop, (NOW + timedelta(hours=10)).isoformat())

    api = FakeApi(balance=100)
    summary = fas.reconcile_subscriptions(session, now=NOW, request=api)
    assert summary["subscribed"] == 1


# ── polling fallback skip ─────────────────────────────────────────────────────

def test_send_flight_alerts_skips_webhook_subscribed_flights(session):
    _, stop = _seed_trip(session)
    _flight(session, stop, (NOW + timedelta(hours=5)).isoformat(),
            details_extra={"alert_subscription_id": "sub-1"})

    fetch_calls = []
    def fetch(iata, date):
        fetch_calls.append(iata)
        return None

    send_flight_alerts(session, now=NOW, fetch=fetch)
    assert fetch_calls == []  # never polled


def test_send_flight_alerts_still_polls_unsubscribed_flights(session):
    _, stop = _seed_trip(session)
    _flight(session, stop, (NOW + timedelta(hours=5)).isoformat())

    fetch_calls = []
    def fetch(iata, date):
        fetch_calls.append(iata)
        return None

    send_flight_alerts(session, now=NOW, fetch=fetch)
    assert fetch_calls == ["KL1395"]


# ── webhook receiver ──────────────────────────────────────────────────────────

def _notification_payload(sub_id, flight):
    return {"subscription": {"id": sub_id}, "flights": [flight], "balance": {"creditsRemaining": 9}}


CANCELLED = {"number": "KL 1395", "status": "Canceled", "departure": {}, "arrival": {},
             "lastUpdatedUtc": "2026-08-01 10:00Z", "codeshareStatus": "IsOperator", "isCargo": False}


def test_webhook_wrong_secret_404s(client: TestClient, monkeypatch):
    monkeypatch.setattr(fas, "WEBHOOK_SECRET", "right")
    r = client.post("/webhooks/aerodatabox/wrong", json=_notification_payload("sub-1", CANCELLED))
    assert r.status_code == 404


def test_webhook_unset_secret_404s(client: TestClient, monkeypatch):
    monkeypatch.setattr(fas, "WEBHOOK_SECRET", "")
    r = client.post("/webhooks/aerodatabox/anything", json=_notification_payload("sub-1", CANCELLED))
    assert r.status_code == 404


def test_webhook_cancellation_sends_alert(client: TestClient, session: Session, monkeypatch):
    monkeypatch.setattr(fas, "WEBHOOK_SECRET", "s3cret")
    _, stop = _seed_trip(session)
    item = _flight(session, stop, (NOW + timedelta(hours=5)).isoformat(),
                   details_extra={"alert_subscription_id": "sub-1"})

    sent = []
    monkeypatch.setattr("backend.notifications.send_push", lambda info, payload, **kw: sent.append(payload))

    r = client.post("/webhooks/aerodatabox/s3cret", json=_notification_payload("sub-1", CANCELLED))
    assert r.status_code == 200
    assert r.json()["alerts_sent"] == 1
    assert sent[0]["title"] == "Flight cancelled"

    logs = session.exec(select(NotificationLog).where(NotificationLog.item_id == item.id)).all()
    assert [l.kind for l in logs] == ["flight_cancel"]


def test_webhook_redelivery_is_idempotent(client: TestClient, session: Session, monkeypatch):
    monkeypatch.setattr(fas, "WEBHOOK_SECRET", "s3cret")
    _, stop = _seed_trip(session)
    item = _flight(session, stop, (NOW + timedelta(hours=5)).isoformat(),
                   details_extra={"alert_subscription_id": "sub-1"})

    sent = []
    monkeypatch.setattr("backend.notifications.send_push", lambda info, payload, **kw: sent.append(payload))

    payload = _notification_payload("sub-1", CANCELLED)
    client.post("/webhooks/aerodatabox/s3cret", json=payload)
    r = client.post("/webhooks/aerodatabox/s3cret", json=payload)
    assert r.status_code == 200
    assert r.json()["alerts_sent"] == 0
    assert len(sent) == 1

    logs = session.exec(select(NotificationLog).where(NotificationLog.item_id == item.id)).all()
    assert len(logs) == 1


def test_webhook_unknown_subscription_returns_2xx_without_alerting(client: TestClient, monkeypatch):
    monkeypatch.setattr(fas, "WEBHOOK_SECRET", "s3cret")
    r = client.post("/webhooks/aerodatabox/s3cret", json=_notification_payload("sub-ghost", CANCELLED))
    assert r.status_code == 200
    assert r.json() == {"processed": 0}


def test_webhook_delay_alert_uses_same_movement_shape_as_polling(client: TestClient, session: Session, monkeypatch):
    monkeypatch.setattr(fas, "WEBHOOK_SECRET", "s3cret")
    _, stop = _seed_trip(session)
    _flight(session, stop, (NOW + timedelta(hours=5)).isoformat(),
            details_extra={"alert_subscription_id": "sub-1"})

    sent = []
    monkeypatch.setattr("backend.notifications.send_push", lambda info, payload, **kw: sent.append(payload))

    delayed = {
        "number": "KL 1395", "status": "Delayed",
        "departure": {
            "scheduledTime": {"utc": "2026-08-01 17:00Z", "local": "2026-08-01 19:00+02:00"},
            "revisedTime": {"utc": "2026-08-01 17:45Z", "local": "2026-08-01 19:45+02:00"},
        },
        "arrival": {}, "lastUpdatedUtc": "2026-08-01 10:00Z",
        "codeshareStatus": "IsOperator", "isCargo": False,
    }
    r = client.post("/webhooks/aerodatabox/s3cret", json=_notification_payload("sub-1", delayed))
    assert r.status_code == 200
    assert r.json()["alerts_sent"] == 1
    assert sent[0]["title"] == "Flight delayed"
    assert "45m late" in sent[0]["body"]
