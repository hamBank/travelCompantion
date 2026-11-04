"""Sliding login session: once a login token is more than halfway through its
life, the next authenticated response carries a fresh one in X-Refreshed-Token.
Personal access tokens, revoked users and error responses never get one.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlmodel import Session

from backend import auth
from backend.routers import auth_router
from backend.models import ApiToken

ADMIN = "admin@example.com"
HEADER = "X-Refreshed-Token"
LIFETIME = timedelta(days=auth.JWT_EXPIRE_DAYS)


def _token(email=ADMIN, age: timedelta = timedelta(0), with_iat=True, extra=None) -> str:
    """A login token issued `age` ago, with the standard lifetime."""
    issued = datetime.now(timezone.utc) - age
    payload = {"sub": email, "name": "N", "picture": "p", "exp": issued + LIFETIME, **(extra or {})}
    if with_iat:
        payload["iat"] = issued
    return jwt.encode(payload, auth.JWT_SECRET, algorithm=auth.JWT_ALGORITHM)


def _get(client, path, token):
    return client.get(path, headers={"Authorization": f"Bearer {token}"})


@pytest.fixture(autouse=True)
def _auth_on(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth, "ALLOWED_EMAIL", ADMIN)


# ── token_refresh_due ────────────────────────────────────────────────────────

def test_due_only_past_halfway():
    def due(age_days):
        issued = datetime.now(timezone.utc) - timedelta(days=age_days)
        return auth.token_refresh_due({"iat": issued.timestamp(), "exp": (issued + LIFETIME).timestamp()})

    assert not due(0)
    assert not due(auth.JWT_EXPIRE_DAYS / 2 - 1)
    assert due(auth.JWT_EXPIRE_DAYS / 2 + 1)
    assert due(auth.JWT_EXPIRE_DAYS - 1)


def test_due_uses_the_tokens_own_lifetime_not_the_configured_one():
    # A 4-day token issued 3 days ago: 1 day left of 4 -> due, even though
    # that's far less than half of JWT_EXPIRE_DAYS either way.
    issued = datetime.now(timezone.utc) - timedelta(days=3)
    assert auth.token_refresh_due({"iat": issued.timestamp(), "exp": (issued + timedelta(days=4)).timestamp()})
    # A 100-day token issued 10 days ago has 90 left -> not due, although 90
    # days left is more than the configured lifetime.
    issued = datetime.now(timezone.utc) - timedelta(days=10)
    assert not auth.token_refresh_due({"iat": issued.timestamp(), "exp": (issued + timedelta(days=100)).timestamp()})


def test_due_assumes_configured_lifetime_for_tokens_without_iat():
    now = datetime.now(timezone.utc)
    legacy = lambda days_left: {"exp": (now + timedelta(days=days_left)).timestamp()}
    assert not auth.token_refresh_due(legacy(auth.JWT_EXPIRE_DAYS - 1))
    assert auth.token_refresh_due(legacy(auth.JWT_EXPIRE_DAYS / 2 - 1))


def test_due_false_without_exp():
    assert not auth.token_refresh_due({})


def test_create_jwt_stamps_iat():
    payload = jwt.decode(auth.create_jwt({"email": ADMIN}), auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert payload["exp"] - payload["iat"] == auth.JWT_EXPIRE_DAYS * 86400


# ── end to end through the middleware ────────────────────────────────────────

def test_fresh_token_gets_no_new_token(client: TestClient):
    r = _get(client, "/trips/", _token())
    assert r.status_code == 200
    assert HEADER not in r.headers


def test_token_past_halfway_gets_a_fresh_one(client: TestClient):
    r = _get(client, "/trips/", _token(age=LIFETIME * 0.6))
    assert r.status_code == 200
    new = jwt.decode(r.headers[HEADER], auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert new["sub"] == ADMIN and new["name"] == "N" and new["picture"] == "p"
    assert new["exp"] - datetime.now(timezone.utc).timestamp() > (LIFETIME * 0.99).total_seconds()


def test_the_fresh_token_is_itself_not_due_again(client: TestClient):
    r = _get(client, "/trips/", _token(age=LIFETIME * 0.6))
    assert HEADER not in _get(client, "/trips/", r.headers[HEADER]).headers


def test_legacy_token_without_iat_is_refreshed_too(client: TestClient):
    r = _get(client, "/trips/", _token(age=LIFETIME * 0.6, with_iat=False))
    assert HEADER in r.headers
    assert "iat" in jwt.decode(r.headers[HEADER], auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])


def test_routes_under_public_prefixes_that_authenticate_also_refresh(client: TestClient):
    r = _get(client, "/auth/me", _token(age=LIFETIME * 0.6))
    assert r.status_code == 200
    assert HEADER in r.headers


def test_error_responses_never_carry_a_new_token(client: TestClient):
    r = _get(client, "/trips/999999", _token(age=LIFETIME * 0.6))
    assert r.status_code >= 400
    assert HEADER not in r.headers


def test_revoked_user_can_finish_their_token_but_not_extend_it(client: TestClient):
    # Not ALLOWED_EMAIL and no trip membership: the sign-in gate says no.
    r = _get(client, "/auth/me", _token(email="gone@example.com", age=LIFETIME * 0.6))
    assert r.status_code == 200
    assert HEADER not in r.headers


def test_member_who_is_not_the_admin_is_refreshed(client: TestClient, session: Session):
    from backend.models import Trip, TripMembership
    trip = Trip(name="T"); session.add(trip); session.commit(); session.refresh(trip)
    session.add(TripMembership(trip_id=trip.id, user_email="friend@example.com", role="viewer")); session.commit()
    r = _get(client, "/auth/me", _token(email="friend@example.com", age=LIFETIME * 0.6))
    assert HEADER in r.headers


def test_personal_access_tokens_are_never_refreshed(client: TestClient, session: Session):
    token, jti, exp = auth.create_api_token({"email": ADMIN, "name": "N"}, days=1)  # 1 day left: "due"
    session.add(ApiToken(jti=jti, user_email=ADMIN, label="t", expires_at=exp)); session.commit()
    r = _get(client, "/auth/me", token)
    assert r.status_code == 200
    assert HEADER not in r.headers


def test_auth_refresh_refuses_a_personal_access_token(client: TestClient, session: Session):
    token, jti, exp = auth.create_api_token({"email": ADMIN, "name": "N"})
    session.add(ApiToken(jti=jti, user_email=ADMIN, label="t", expires_at=exp)); session.commit()
    r = client.post("/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403
    assert "access_token" not in r.text
