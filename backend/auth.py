import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from sqlmodel import Session
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from .database import get_session
from .metrics import record_external_call

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
JWT_SECRET       = os.environ.get("JWT_SECRET", "dev-secret-change-in-production")
JWT_ALGORITHM    = "HS256"
JWT_EXPIRE_DAYS  = int(os.environ.get("JWT_EXPIRE_DAYS", "30"))
ALLOWED_EMAIL    = os.environ.get("ALLOWED_EMAIL", "").lower()

# Auth is only enforced when GOOGLE_CLIENT_ID is configured.
# Without it the app works as before (useful for local dev).
AUTH_ENABLED = bool(GOOGLE_CLIENT_ID)

_security = HTTPBearer(auto_error=False)


def verify_google_token(credential: str) -> dict:
    try:
        idinfo = id_token.verify_oauth2_token(
            credential, google_requests.Request(), GOOGLE_CLIENT_ID
        )
    except Exception as e:
        # Covers both a genuinely invalid/expired token and a network failure
        # fetching Google's public signing certs — can't cleanly distinguish
        # from here, but either way it's worth seeing in the error rate.
        record_external_call("google_oauth", ok=False, error=str(e))
        raise
    record_external_call("google_oauth", ok=True)
    return {
        "email": idinfo["email"],
        "name":  idinfo.get("name", ""),
        "picture": idinfo.get("picture", ""),
    }


def create_jwt(user: dict) -> str:
    payload = {
        "sub":     user["email"],
        "name":    user.get("name", ""),
        "picture": user.get("picture", ""),
        "exp":     datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


# ── Personal access tokens (programmatic / non-browser clients) ────────────────
# A PAT is a signed JWT (same signing as the login token, so it passes the auth
# middleware unchanged) that additionally carries a `jti` backed by an ApiToken
# row. That makes it *revocable*: get_current_user rejects a token whose jti has
# no row or a revoked one, so a leaked/retired token can be killed individually
# without rotating JWT_SECRET. It still grants full account access — treat it
# like a password. The `scope: "api"` claim keeps it distinguishable in logs and
# tells get_current_user to run the revocation check. See create_personal_api_token
# / list / revoke in routers/me.py.
import secrets  # noqa: E402

API_TOKEN_SCOPE       = "api"
API_TOKEN_EXPIRE_DAYS = int(os.environ.get("API_TOKEN_EXPIRE_DAYS", "365"))


def create_api_token(user: dict, days: Optional[int] = None) -> tuple[str, str, datetime]:
    """Mint a personal access token for `user`. `days` is clamped to
    [1, API_TOKEN_EXPIRE_DAYS]; None uses the full default. Returns
    (token, jti, naive-UTC expiry) — the caller persists an ApiToken row keyed
    by `jti` so the token can later be listed and revoked."""
    ttl = API_TOKEN_EXPIRE_DAYS if days is None else max(1, min(int(days), API_TOKEN_EXPIRE_DAYS))
    exp = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=ttl)
    jti = secrets.token_urlsafe(12)
    payload = {
        "sub":     user["email"],
        "name":    user.get("name", ""),
        "picture": user.get("picture", ""),
        "scope":   API_TOKEN_SCOPE,
        "jti":     jti,
        "exp":     exp,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM), jti, exp


def api_token_active(session, jti: str) -> bool:
    """True if `jti` names an ApiToken row that exists and hasn't been revoked.
    Uses the caller's request-scoped session (so it respects test overrides and
    opens no extra connection). A blank jti is never active."""
    if not jti:
        return False
    from sqlmodel import select
    from .models import ApiToken
    row = session.exec(select(ApiToken).where(ApiToken.jti == jti)).first()
    return bool(row and row.revoked_at is None)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_security),
    session: Session = Depends(get_session),
) -> dict:
    if not AUTH_ENABLED:
        return {"email": "dev@local", "name": "Dev", "picture": ""}
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Personal access tokens (scope "api") are revocable — reject one whose jti
    # has been revoked or no longer exists. Login tokens carry no such scope and
    # skip the lookup. `session` is only a real Session under FastAPI DI; when
    # get_current_user is called directly (e.g. unit tests) it's the unresolved
    # Depends marker, so the check is skipped there.
    if payload.get("scope") == API_TOKEN_SCOPE and isinstance(session, Session):
        if not api_token_active(session, payload.get("jti")):
            raise HTTPException(status_code=401, detail="Token revoked")

    return {
        "email":   payload["sub"],
        "name":    payload.get("name", ""),
        "picture": payload.get("picture", ""),
    }


# ── iCal feed tokens ───────────────────────────────────────────────────────────
# Stateless, scope-limited tokens for the public "subscribe in your calendar
# app" feed (GET /calendar/{token}.ics — see backend/routers/calendar.py).
# No new schema: same JWT_SECRET/JWT_ALGORITHM as login tokens, just a
# different (narrower) payload, so no DB lookup is needed to serve the feed.

ICAL_SCOPE = "ical"


def create_ical_token(trip_id: int) -> str:
    """A token that grants read-only access to exactly one trip's calendar
    feed and nothing else — {"trip_id": N, "scope": "ical"} carries no user
    identity, so anyone holding the URL can subscribe with no login, same as
    Google/Apple's own "secret address" ICS links.

    Deliberately has no `exp` claim: the whole point is a link that keeps
    working whenever the user's calendar app polls it (days/weeks later),
    and unlike a login session there's no compromised-account blast radius
    to bound — the token can only ever read this one trip's calendar data.
    """
    payload = {"trip_id": trip_id, "scope": ICAL_SCOPE}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_ical_token(token: str) -> Optional[int]:
    """Return the trip_id encoded in a valid ical-scoped token, or None.

    Returns None (never raises) for every failure mode — bad signature,
    malformed token, wrong scope — so the caller can 404 uniformly. Callers
    must not distinguish "invalid" from "wrong trip" in the response: a 401
    or a different error code would tell an attacker their forged token was
    at least well-formed.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        return None
    if payload.get("scope") != ICAL_SCOPE:
        return None
    trip_id = payload.get("trip_id")
    if not isinstance(trip_id, int):
        return None
    return trip_id
