"""The JWT wire contract, independent of which library implements it.

Fleet spec AUTH-8 swaps python-jose for PyJWT. Sessions already issued (30-day
login tokens) and calendar-feed links already handed to calendar apps must keep
working across that swap, and forged or expired tokens must keep failing. These
tests build and check tokens by hand with hmac/base64 (no JWT library), so they
pass or fail on the behaviour, not on the library under test.
"""
import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from backend import auth
from backend.routers import auth_router

ADMIN = "admin@example.com"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _hand_token(payload: dict, secret: str = None, alg: str = "HS256", sign: bool = True) -> str:
    """Build a compact JWS exactly as the wire format defines it."""
    secret = auth.JWT_SECRET if secret is None else secret
    header = _b64(json.dumps({"alg": alg, "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header}.{body}".encode()
    if not sign:
        return f"{header}.{body}."
    digest = {"HS256": hashlib.sha256, "HS512": hashlib.sha512}[alg]
    sig = _b64(hmac.new(secret.encode(), signing_input, digest).digest())
    return f"{header}.{body}.{sig}"


def _login_payload(**over) -> dict:
    now = int(time.time())
    return {"sub": ADMIN, "name": "N", "picture": "p", "iat": now, "exp": now + 3600, **over}


@pytest.fixture(autouse=True)
def _auth_on(monkeypatch):
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth, "ALLOWED_EMAILS", [])


def _me(client: TestClient, token: str):
    return client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})


# ── tokens built by hand are accepted ────────────────────────────────────────

def test_a_login_token_built_by_hand_is_accepted(client: TestClient):
    r = _me(client, _hand_token(_login_payload()))
    assert r.status_code == 200 and r.json()["email"] == ADMIN


def test_a_legacy_login_token_without_iat_is_accepted(client: TestClient):
    payload = _login_payload()
    del payload["iat"]
    assert _me(client, _hand_token(payload)).status_code == 200


def test_an_ical_token_without_exp_still_verifies():
    # Calendar-feed links have no expiry and are already in people's calendar apps.
    token = _hand_token({"trip_id": 7, "scope": "ical"})
    assert auth.verify_ical_token(token) == 7


# ── forged, expired and malformed tokens are refused ─────────────────────────

@pytest.mark.parametrize("make", [
    lambda: _hand_token(_login_payload(exp=int(time.time()) - 10)),       # expired
    lambda: _hand_token(_login_payload(), secret="not-the-secret"),       # wrong key
    lambda: _hand_token(_login_payload(), alg="HS512"),                   # other HMAC alg
    lambda: _hand_token(_login_payload(), alg="none", sign=False),        # unsigned
    lambda: _hand_token(_login_payload())[:-2] + "xx",                    # tampered signature
    lambda: "not-a-jwt",
    lambda: "a.b.c",
    lambda: "",
], ids=["expired", "wrong-key", "hs512", "alg-none", "tampered", "garbage", "abc", "empty"])
def test_bad_tokens_are_401_on_a_router_route(client: TestClient, make):
    assert _me(client, make()).status_code == 401


@pytest.mark.parametrize("make", [
    lambda: _hand_token(_login_payload(exp=int(time.time()) - 10)),
    lambda: _hand_token(_login_payload(), secret="not-the-secret"),
    lambda: _hand_token(_login_payload(), alg="none", sign=False),
    lambda: "not-a-jwt",
], ids=["expired", "wrong-key", "alg-none", "garbage"])
def test_bad_tokens_are_401_in_the_middleware_too(client: TestClient, make):
    # /trips is a protected prefix handled by the middleware's own decode.
    r = client.get("/trips", headers={"Authorization": f"Bearer {make()}"})
    assert r.status_code == 401


@pytest.mark.parametrize("make", [
    lambda: _hand_token({"trip_id": 7, "scope": "ical"}, secret="not-the-secret"),
    lambda: _hand_token({"trip_id": 7, "scope": "ical"}, alg="none", sign=False),
    lambda: _hand_token({"trip_id": 7, "scope": "something_else"}),
    lambda: _hand_token({"scope": "ical"}),
    lambda: "garbage",
], ids=["wrong-key", "alg-none", "wrong-scope", "no-trip", "garbage"])
def test_bad_ical_tokens_are_none_never_an_exception(make):
    assert auth.verify_ical_token(make()) is None


# ── tokens we mint are standard JWS that anyone can verify ───────────────────

def _verify_by_hand(token: str) -> dict:
    header_b64, body_b64, sig_b64 = token.split(".")
    header = json.loads(_unb64(header_b64))
    assert header["alg"] == "HS256"
    expected = hmac.new(auth.JWT_SECRET.encode(), f"{header_b64}.{body_b64}".encode(), hashlib.sha256).digest()
    assert hmac.compare_digest(expected, _unb64(sig_b64))
    return json.loads(_unb64(body_b64))


def test_a_minted_login_token_is_plain_hs256_with_integer_times():
    claims = _verify_by_hand(auth.create_jwt({"email": ADMIN, "name": "N", "picture": "p"}))
    assert claims["sub"] == ADMIN
    assert isinstance(claims["iat"], int) and isinstance(claims["exp"], int)
    assert claims["exp"] - claims["iat"] == auth.JWT_EXPIRE_DAYS * 86400


def test_a_minted_api_token_carries_scope_jti_and_exp():
    token, jti, exp = auth.create_api_token({"email": ADMIN})
    claims = _verify_by_hand(token)
    assert claims["scope"] == auth.API_TOKEN_SCOPE and claims["jti"] == jti
    assert isinstance(claims["exp"], int) and "iat" not in claims


def test_a_minted_ical_token_has_no_exp():
    claims = _verify_by_hand(auth.create_ical_token(7))
    assert claims == {"trip_id": 7, "scope": "ical"}
