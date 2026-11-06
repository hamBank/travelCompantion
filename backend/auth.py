import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt
from sqlmodel import Session
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests
from .allowlist import parse_allowed_emails
from .config import get_settings
from .database import get_session
from .metrics import record_external_call

class ConfigError(RuntimeError):
    """Raised at import when the auth configuration is unsafe. The process must
    not start: the alternative is serving with authentication silently off, or
    with a signing secret anyone can read in the source."""


_cfg = get_settings()
GOOGLE_CLIENT_ID = _cfg.google_client_id
_DEFAULT_JWT_SECRET = "dev-secret-change-in-production"
JWT_SECRET       = _cfg.jwt_secret or _DEFAULT_JWT_SECRET
JWT_ALGORITHM    = "HS256"
JWT_EXPIRE_DAYS  = _cfg.jwt_expire_days
ALLOWED_EMAILS  = parse_allowed_emails({"ALLOWED_EMAILS": _cfg.allowed_emails, "ALLOWED_EMAIL": _cfg.allowed_email})
# Identity used when auth is disabled (local dev / tests). Fleet spec CFG-5.
DEV_USER_EMAIL  = "dev@localhost"


def resolve_auth_enabled(env) -> bool:
    """AUTH_ENABLED is an explicit setting that fails closed (fleet spec CFG-3).

    It used to be derived from GOOGLE_CLIENT_ID being non-empty, so losing that
    one line from .env switched authentication off with no error. Now:
      AUTH_ENABLED=true/false  -> as stated.
      unset, GOOGLE_CLIENT_ID set -> enabled, with a warning to set it
        explicitly (keeps existing deployments working through the change).
      unset, no GOOGLE_CLIENT_ID  -> refuse to start. Local dev must say
        AUTH_ENABLED=false on purpose.
    """
    raw = (env.get("AUTH_ENABLED") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    if raw:
        raise ConfigError(f"AUTH_ENABLED={raw!r} is not a boolean: use true or false.")
    if env.get("GOOGLE_CLIENT_ID"):
        logging.getLogger(__name__).warning(
            "AUTH_ENABLED is not set; treating authentication as enabled because "
            "GOOGLE_CLIENT_ID is set. Add AUTH_ENABLED=true to .env.")
        return True
    raise ConfigError(
        "AUTH_ENABLED is not set and GOOGLE_CLIENT_ID is empty: refusing to start with "
        "authentication silently off. Set AUTH_ENABLED=false for local development, or "
        "set AUTH_ENABLED=true with GOOGLE_CLIENT_ID.")


def validate_auth_config(enabled: bool, client_id: str, secret: str) -> None:
    """With auth enabled the process needs a client id to verify logins and a
    private signing secret (fleet spec CFG-2). The default secret is in the
    source, so anyone could mint a valid token with it."""
    if not enabled:
        return
    if not client_id:
        raise ConfigError("AUTH_ENABLED=true but GOOGLE_CLIENT_ID is empty.")
    if not secret or secret == _DEFAULT_JWT_SECRET:
        raise ConfigError(
            "JWT_SECRET is unset or still the public default: anyone could forge a login "
            "token. Set it to a long random string, e.g. `openssl rand -hex 32`.")


AUTH_ENABLED = resolve_auth_enabled({"AUTH_ENABLED": _cfg.auth_enabled, "GOOGLE_CLIENT_ID": _cfg.google_client_id})
validate_auth_config(AUTH_ENABLED, GOOGLE_CLIENT_ID, JWT_SECRET)

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
    now = datetime.now(timezone.utc)
    payload = {
        "sub":     user["email"],
        "name":    user.get("name", ""),
        "picture": user.get("picture", ""),
        "iat":     now,
        "exp":     now + timedelta(days=JWT_EXPIRE_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def email_authorised(session, email: str) -> bool:
    """The sign-in gate: anyone on the ALLOWED_EMAILS list, or anyone who has
    been shared at least one trip (any TripMembership). When ALLOWED_EMAILS is
    unset, anyone with a Google account may sign in (membership then gates
    access). Shared by /auth/google, /auth/refresh and the sliding refresh in
    get_current_user, so revoking someone's access stops all three."""
    email = email.lower()
    if not ALLOWED_EMAILS or email in ALLOWED_EMAILS:
        return True
    from sqlmodel import select
    from .models import TripMembership
    return session.exec(
        select(TripMembership).where(TripMembership.user_email == email)
    ).first() is not None


def token_refresh_due(payload: dict, now: Optional[datetime] = None) -> bool:
    """True once a login token is more than halfway through its life.

    Lifetime is exp - iat. Tokens minted before `iat` was added have none, so
    they're assumed to have been issued with the current JWT_EXPIRE_DAYS.
    """
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    iat = payload.get("iat")
    if isinstance(iat, (int, float)) and exp > iat:
        lifetime = exp - iat
    else:
        lifetime = JWT_EXPIRE_DAYS * 86400
    now_ts = (now or datetime.now(timezone.utc)).timestamp()
    return exp - now_ts < lifetime / 2


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
API_TOKEN_EXPIRE_DAYS = _cfg.api_token_expire_days


def create_api_token(user: dict, days: Optional[int] = None) -> tuple[str, str, datetime]:
    """Mint a personal access token for `user`. `days` is clamped to
    [1, API_TOKEN_EXPIRE_DAYS]; None uses the full default. Returns
    (token, jti, aware-UTC expiry) — the caller persists an ApiToken row keyed
    by `jti` so the token can later be listed and revoked."""
    ttl = API_TOKEN_EXPIRE_DAYS if days is None else max(1, min(int(days), API_TOKEN_EXPIRE_DAYS))
    exp = datetime.now(timezone.utc) + timedelta(days=ttl)
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
    request: Request = None,
) -> dict:
    if not AUTH_ENABLED:
        return {"email": DEV_USER_EMAIL, "name": "Dev", "picture": ""}
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(
            credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM]
        )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    # Personal access tokens (scope "api") are revocable — reject one whose jti
    # has been revoked or no longer exists. Login tokens carry no such scope and
    # skip the lookup. `session` is only a real Session under FastAPI DI; when
    # get_current_user is called directly (e.g. unit tests) it's the unresolved
    # Depends marker, so the check is skipped there.
    if payload.get("scope") == API_TOKEN_SCOPE and isinstance(session, Session):
        if not api_token_active(session, payload.get("jti")):
            raise HTTPException(status_code=401, detail="Token revoked")

    user = {
        "email":   payload["sub"],
        "name":    payload.get("name", ""),
        "picture": payload.get("picture", ""),
    }

    # Sliding session: a login token past halfway through its life gets a fresh
    # one handed back, which main.py's auth_middleware attaches to the response
    # as X-Refreshed-Token for the frontend to store. Login tokens only — a
    # personal access token keeps its fixed, revocable lifetime. Someone whose
    # access has been revoked since login can see out their current token but
    # can't extend it. (`request` is None when called directly in unit tests.)
    if request is not None:
        request.state.token_scope = payload.get("scope")
        if (
            payload.get("scope") is None
            and token_refresh_due(payload)
            and isinstance(session, Session)
            and email_authorised(session, user["email"])
        ):
            request.state.refreshed_token = create_jwt(user)

    return user


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
    except jwt.PyJWTError:
        return None
    if payload.get("scope") != ICAL_SCOPE:
        return None
    trip_id = payload.get("trip_id")
    if not isinstance(trip_id, int):
        return None
    return trip_id
