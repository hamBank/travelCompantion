"""Unit + endpoint tests for backend/auth.py and backend/routers/auth_router.py."""
import pytest
from datetime import datetime, timedelta, timezone
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient
from jose import jwt
from sqlmodel import Session

from backend import auth
from backend.routers import auth_router
from backend.models import Trip, TripMembership


def _bearer(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


# ── create_jwt ──────────────────────────────────────────────────────────────

def test_create_jwt_encodes_user_claims():
    token = auth.create_jwt({"email": "a@example.com", "name": "Ann", "picture": "pic.png"})
    payload = jwt.decode(token, auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert payload["sub"] == "a@example.com"
    assert payload["name"] == "Ann"
    assert payload["picture"] == "pic.png"


def test_create_jwt_defaults_name_and_picture_to_empty():
    token = auth.create_jwt({"email": "a@example.com"})
    payload = jwt.decode(token, auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert payload["name"] == ""
    assert payload["picture"] == ""


def test_create_jwt_expiry_is_jwt_expire_days_out(monkeypatch):
    monkeypatch.setattr(auth, "JWT_EXPIRE_DAYS", 30)
    token = auth.create_jwt({"email": "a@example.com"})
    payload = jwt.decode(token, auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    exp = datetime.fromtimestamp(payload["exp"], timezone.utc).replace(tzinfo=None)
    delta = exp - datetime.now(timezone.utc).replace(tzinfo=None)
    assert timedelta(days=29) < delta <= timedelta(days=30)


# ── get_current_user: AUTH disabled (local dev) ────────────────────────────

def test_get_current_user_returns_dev_user_when_auth_disabled(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    user = auth.get_current_user(credentials=None)
    assert user == {"email": "dev@local", "name": "Dev", "picture": ""}


def test_get_current_user_ignores_bad_credentials_when_auth_disabled(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)
    user = auth.get_current_user(credentials=_bearer("garbage"))
    assert user["email"] == "dev@local"


# ── get_current_user: AUTH enabled ──────────────────────────────────────────

def test_get_current_user_requires_credentials_when_auth_enabled(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    with pytest.raises(HTTPException) as exc:
        auth.get_current_user(credentials=None)
    assert exc.value.status_code == 401


def test_get_current_user_accepts_valid_token(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    token = auth.create_jwt({"email": "user@example.com", "name": "User", "picture": "p.png"})
    user = auth.get_current_user(credentials=_bearer(token))
    assert user == {"email": "user@example.com", "name": "User", "picture": "p.png"}


def test_get_current_user_rejects_expired_token(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    payload = {"sub": "user@example.com", "exp": datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)}
    expired = jwt.encode(payload, auth.JWT_SECRET, algorithm=auth.JWT_ALGORITHM)
    with pytest.raises(HTTPException) as exc:
        auth.get_current_user(credentials=_bearer(expired))
    assert exc.value.status_code == 401


def test_get_current_user_rejects_token_signed_with_wrong_secret(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    payload = {"sub": "user@example.com", "exp": datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=1)}
    tampered = jwt.encode(payload, "not-the-real-secret", algorithm=auth.JWT_ALGORITHM)
    with pytest.raises(HTTPException) as exc:
        auth.get_current_user(credentials=_bearer(tampered))
    assert exc.value.status_code == 401


def test_get_current_user_rejects_malformed_token(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    with pytest.raises(HTTPException) as exc:
        auth.get_current_user(credentials=_bearer("not.a.jwt"))
    assert exc.value.status_code == 401


# ── create_api_token (personal access tokens) ───────────────────────────────

def test_create_api_token_carries_identity_scope_and_jti():
    token, jti, exp = auth.create_api_token({"email": "a@example.com", "name": "Ann", "picture": "p.png"})
    payload = jwt.decode(token, auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert payload["sub"] == "a@example.com"
    assert payload["name"] == "Ann"
    assert payload["scope"] == "api"
    assert payload["jti"] == jti and jti


def test_create_api_token_default_lifetime_is_api_expire_days(monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN_EXPIRE_DAYS", 365)
    token, _jti, exp = auth.create_api_token({"email": "a@example.com"})
    payload = jwt.decode(token, auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    got = datetime.fromtimestamp(payload["exp"], timezone.utc).replace(tzinfo=None)
    delta = got - datetime.now(timezone.utc).replace(tzinfo=None)
    assert timedelta(days=364) < delta <= timedelta(days=365)


def test_create_api_token_clamps_requested_days(monkeypatch):
    monkeypatch.setattr(auth, "API_TOKEN_EXPIRE_DAYS", 365)
    # Over the cap → clamped down; zero/negative → floored to 1.
    _, _, exp_hi = auth.create_api_token({"email": "a@example.com"}, days=100000)
    _, _, exp_lo = auth.create_api_token({"email": "a@example.com"}, days=0)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    assert (exp_hi - now) <= timedelta(days=365)
    assert timedelta(hours=23) < (exp_lo - now) <= timedelta(days=1)


def test_api_token_decodes_to_the_user_like_a_login_token(monkeypatch):
    # get_current_user only decodes claims (revocation is enforced by the
    # middleware, tested separately) — so a well-formed PAT resolves its user.
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    token, _jti, _exp = auth.create_api_token({"email": "user@example.com", "name": "User", "picture": "p.png"})
    user = auth.get_current_user(credentials=_bearer(token))
    assert user == {"email": "user@example.com", "name": "User", "picture": "p.png"}


# ── /me/api-token(s): mint / list / revoke ───────────────────────────────────

def test_mint_api_token_persists_a_revocable_row(client: TestClient, session: Session):
    from backend.models import ApiToken

    r = client.post("/me/api-token", json={"label": "cli"})
    assert r.status_code == 200
    data = r.json()
    assert data["token_type"] == "bearer" and data["email"] == "dev@local"
    assert data["label"] == "cli" and isinstance(data["id"], int)
    payload = jwt.decode(data["token"], auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert payload["scope"] == "api"

    row = session.get(ApiToken, data["id"])
    assert row is not None
    assert row.jti == payload["jti"]
    assert row.user_email == "dev@local"
    assert row.revoked_at is None


def test_mint_response_expires_at_matches_list_response_format(client: TestClient):
    """docs/programmatic-api.md documents one format (plain ISO, no "Z") for
    expires_at in both the mint and list responses — they must actually agree,
    not just each individually look like a datetime."""
    minted = client.post("/me/api-token", json={"label": "fmt"}).json()
    listed = client.get("/me/api-tokens").json()
    row = next(t for t in listed if t["id"] == minted["id"])
    assert minted["expires_at"] == row["expires_at"]
    assert not minted["expires_at"].endswith("Z")


def test_list_and_revoke_api_tokens(client: TestClient, session: Session):
    from backend.models import ApiToken

    tid = client.post("/me/api-token", json={"label": "one"}).json()["id"]

    listed = client.get("/me/api-tokens").json()
    assert [t["id"] for t in listed] == [tid]
    assert listed[0]["revoked_at"] is None

    r = client.delete(f"/me/api-tokens/{tid}")
    assert r.status_code == 204
    assert session.get(ApiToken, tid).revoked_at is not None

    # Revoke is idempotent, and a stranger's / unknown id is a 404.
    assert client.delete(f"/me/api-tokens/{tid}").status_code == 204
    assert client.delete("/me/api-tokens/999999").status_code == 404


def test_list_api_tokens_orders_newest_first(client: TestClient):
    first = client.post("/me/api-token", json={"label": "first"}).json()["id"]
    second = client.post("/me/api-token", json={"label": "second"}).json()["id"]
    third = client.post("/me/api-token", json={"label": "third"}).json()["id"]

    listed = client.get("/me/api-tokens").json()
    assert [t["id"] for t in listed] == [third, second, first]


def test_revoked_token_is_rejected_by_the_auth_gate(client: TestClient, session: Session, monkeypatch):
    """End-to-end: a PAT authenticates on a protected route until its row is
    revoked, after which get_current_user (using the request session) rejects it."""
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)

    token, jti, exp = auth.create_api_token({"email": "dev@local", "name": "Dev"})
    from backend.models import ApiToken
    row = ApiToken(jti=jti, user_email="dev@local", expires_at=exp)
    session.add(row); session.commit(); session.refresh(row)

    hdr = {"Authorization": f"Bearer {token}"}
    assert client.get("/trips/", headers=hdr).status_code == 200   # active → allowed

    row.revoked_at = datetime.utcnow()
    session.add(row); session.commit()
    assert client.get("/trips/", headers=hdr).status_code == 401   # revoked → rejected


# ── verify_google_token ──────────────────────────────────────────────────────

def test_verify_google_token_maps_idinfo_fields(monkeypatch):
    monkeypatch.setattr(
        auth.id_token, "verify_oauth2_token",
        lambda credential, request, client_id: {
            "email": "g@example.com", "name": "G User", "picture": "gp.png",
        },
    )
    result = auth.verify_google_token("some-credential")
    assert result == {"email": "g@example.com", "name": "G User", "picture": "gp.png"}


def test_verify_google_token_defaults_missing_optional_fields(monkeypatch):
    monkeypatch.setattr(
        auth.id_token, "verify_oauth2_token",
        lambda credential, request, client_id: {"email": "g@example.com"},
    )
    result = auth.verify_google_token("some-credential")
    assert result == {"email": "g@example.com", "name": "", "picture": ""}


def test_verify_google_token_propagates_verification_failure(monkeypatch):
    def boom(credential, request, client_id):
        raise ValueError("Token used too late")

    monkeypatch.setattr(auth.id_token, "verify_oauth2_token", boom)
    with pytest.raises(ValueError):
        auth.verify_google_token("bad-credential")


# ── /auth/config ─────────────────────────────────────────────────────────────

def test_auth_config_reports_disabled_by_default(client: TestClient):
    r = client.get("/auth/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": False, "client_id": ""}


def test_auth_config_reports_enabled_with_client_id(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "GOOGLE_CLIENT_ID", "test-client-id")
    r = client.get("/auth/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "client_id": "test-client-id"}


# ── /auth/me ─────────────────────────────────────────────────────────────────

def test_get_me_returns_dev_user_when_auth_disabled(client: TestClient):
    r = client.get("/auth/me")
    assert r.status_code == 200
    assert r.json()["email"] == "dev@local"


def test_get_me_requires_bearer_token_when_auth_enabled(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    r = client.get("/auth/me")
    assert r.status_code == 401


def test_get_me_returns_claims_from_valid_token(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    token = auth.create_jwt({"email": "user@example.com", "name": "User"})
    r = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["email"] == "user@example.com"


# ── POST /auth/google ────────────────────────────────────────────────────────

def test_google_auth_returns_503_when_auth_not_configured(client: TestClient):
    r = client.post("/auth/google", json={"credential": "whatever"})
    assert r.status_code == 503


def test_google_auth_returns_401_on_invalid_google_token(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)

    def boom(credential):
        raise ValueError("invalid token")

    monkeypatch.setattr(auth_router, "verify_google_token", boom)
    r = client.post("/auth/google", json={"credential": "bad"})
    assert r.status_code == 401


def test_google_auth_rejects_unauthorised_email_with_no_membership(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "ALLOWED_EMAIL", "admin@example.com")
    monkeypatch.setattr(
        auth_router, "verify_google_token",
        lambda credential: {"email": "stranger@example.com", "name": "Stranger", "picture": ""},
    )
    r = client.post("/auth/google", json={"credential": "good"})
    assert r.status_code == 403


def test_google_auth_allows_bootstrap_admin_email(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "ALLOWED_EMAIL", "admin@example.com")
    monkeypatch.setattr(
        auth_router, "verify_google_token",
        lambda credential: {"email": "admin@example.com", "name": "Admin", "picture": ""},
    )
    r = client.post("/auth/google", json={"credential": "good"})
    assert r.status_code == 200
    data = r.json()
    assert data["user"]["email"] == "admin@example.com"
    payload = jwt.decode(data["access_token"], auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert payload["sub"] == "admin@example.com"


def test_google_auth_allows_any_account_when_allowed_email_unset(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "ALLOWED_EMAIL", "")
    monkeypatch.setattr(
        auth_router, "verify_google_token",
        lambda credential: {"email": "anyone@example.com", "name": "Anyone", "picture": ""},
    )
    r = client.post("/auth/google", json={"credential": "good"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "anyone@example.com"


# ── POST /auth/refresh ───────────────────────────────────────────────────────

def test_refresh_returns_503_when_auth_not_configured(client: TestClient):
    r = client.post("/auth/refresh")
    assert r.status_code == 503


def test_refresh_requires_valid_token(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    r = client.post("/auth/refresh")
    assert r.status_code == 401
    r = client.post("/auth/refresh", headers={"Authorization": "Bearer not.a.jwt"})
    assert r.status_code == 401


def test_refresh_issues_a_new_token_with_fresh_expiry(client: TestClient, monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "ALLOWED_EMAIL", "admin@example.com")
    # A token nearing the end of its life (2 days left of a 30-day lifetime).
    old_payload = {
        "sub": "admin@example.com", "name": "Admin", "picture": "p.png",
        "exp": datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=2),
    }
    old_token = jwt.encode(old_payload, auth.JWT_SECRET, algorithm=auth.JWT_ALGORITHM)

    r = client.post("/auth/refresh", headers={"Authorization": f"Bearer {old_token}"})
    assert r.status_code == 200
    data = r.json()
    assert data["user"]["email"] == "admin@example.com"
    new_payload = jwt.decode(data["access_token"], auth.JWT_SECRET, algorithms=[auth.JWT_ALGORITHM])
    assert new_payload["sub"] == "admin@example.com"
    assert new_payload["name"] == "Admin"
    assert new_payload["picture"] == "p.png"
    # Fresh full lifetime, not the old token's remaining 2 days.
    new_exp = datetime.fromtimestamp(new_payload["exp"], timezone.utc).replace(tzinfo=None)
    assert new_exp - datetime.now(timezone.utc).replace(tzinfo=None) > timedelta(days=auth.JWT_EXPIRE_DAYS - 1)


def test_refresh_rejects_revoked_user_with_no_membership(client: TestClient, monkeypatch):
    """Same gate as login: a user removed from every trip since signing in
    can't extend their session."""
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "ALLOWED_EMAIL", "admin@example.com")
    token = auth.create_jwt({"email": "revoked@example.com", "name": "Gone"})
    r = client.post("/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403


def test_refresh_allows_member_user(client: TestClient, session: Session, monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "ALLOWED_EMAIL", "admin@example.com")
    trip = Trip(name="T")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(TripMembership(trip_id=trip.id, user_email="shared@example.com", role="viewer"))
    session.commit()

    token = auth.create_jwt({"email": "shared@example.com", "name": "Shared"})
    r = client.post("/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "shared@example.com"


def test_google_auth_allows_email_with_existing_trip_membership(
    client: TestClient, session: Session, monkeypatch
):
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "ALLOWED_EMAIL", "admin@example.com")
    monkeypatch.setattr(
        auth_router, "verify_google_token",
        lambda credential: {"email": "shared@example.com", "name": "Shared", "picture": ""},
    )
    trip = Trip(name="Existing Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(TripMembership(trip_id=trip.id, user_email="shared@example.com", role="viewer"))
    session.commit()

    r = client.post("/auth/google", json={"credential": "good"})
    assert r.status_code == 200
    assert r.json()["user"]["email"] == "shared@example.com"
