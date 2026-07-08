import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
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


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_security),
) -> dict:
    if not AUTH_ENABLED:
        return {"email": "dev@local", "name": "Dev", "picture": ""}
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
        return {
            "email":   payload["sub"],
            "name":    payload.get("name", ""),
            "picture": payload.get("picture", ""),
        }
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


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
