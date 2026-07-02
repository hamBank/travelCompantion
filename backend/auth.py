import os
from datetime import datetime, timedelta, timezone
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
