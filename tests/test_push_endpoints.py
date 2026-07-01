"""Tests for the /push/* subscription endpoints."""
from backend.models import PushSubscription
from sqlmodel import select


def test_debug_log_accepts_any_json_and_never_errors(client):
    r = client.post("/push/debug-log", json={"stage": "test", "foo": "bar"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_debug_log_tolerates_empty_body(client):
    r = client.post("/push/debug-log")
    assert r.status_code == 200


def test_vapid_public_key_503_when_unconfigured(client, monkeypatch):
    import backend.routers.push as push_router
    monkeypatch.setattr(push_router, "get_vapid_public_key", lambda: None)
    r = client.get("/push/vapid-public-key")
    assert r.status_code == 503


def test_vapid_public_key_returned_when_configured(client, monkeypatch):
    import backend.routers.push as push_router
    monkeypatch.setattr(push_router, "get_vapid_public_key", lambda: "abc123")
    r = client.get("/push/vapid-public-key")
    assert r.status_code == 200
    assert r.json() == {"key": "abc123"}


def test_subscribe_creates_row(client, session):
    r = client.post("/push/subscribe", json={
        "endpoint": "https://push.example/1", "p256dh": "p", "auth": "a", "device_label": "Chrome",
    })
    assert r.status_code == 200
    rows = session.exec(select(PushSubscription)).all()
    assert len(rows) == 1
    assert rows[0].endpoint == "https://push.example/1"
    assert rows[0].user_email == "dev@local"   # auth disabled → dev user


def test_subscribe_upserts_on_same_endpoint(client, session):
    body = {"endpoint": "https://push.example/1", "p256dh": "p1", "auth": "a1", "device_label": ""}
    client.post("/push/subscribe", json=body)
    body["p256dh"] = "p2"
    client.post("/push/subscribe", json=body)
    rows = session.exec(select(PushSubscription)).all()
    assert len(rows) == 1
    assert rows[0].p256dh == "p2"


def test_unsubscribe_removes_own_subscription(client, session):
    client.post("/push/subscribe", json={"endpoint": "https://push.example/1", "p256dh": "p", "auth": "a", "device_label": ""})
    r = client.delete("/push/subscribe", params={"endpoint": "https://push.example/1"})
    assert r.status_code == 200
    assert session.exec(select(PushSubscription)).all() == []


def test_unsubscribe_nonexistent_endpoint_is_a_noop(client):
    r = client.delete("/push/subscribe", params={"endpoint": "https://nope"})
    assert r.status_code == 200
