from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import SQLModel, Session
from ..database import get_session
from ..auth import (
    verify_google_token, create_jwt, get_current_user, email_authorised,
    GOOGLE_CLIENT_ID, AUTH_ENABLED,
)

router = APIRouter(tags=["auth"])


class GoogleAuthRequest(SQLModel):
    credential: str


@router.post("/auth/google")
def google_auth(req: GoogleAuthRequest, session: Session = Depends(get_session)):
    if not AUTH_ENABLED:
        raise HTTPException(status_code=503, detail="Auth not configured (GOOGLE_CLIENT_ID not set)")
    try:
        user = verify_google_token(req.credential)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {e}")

    if not email_authorised(session, user["email"]):
        raise HTTPException(status_code=403, detail="This Google account is not authorised")

    return {"access_token": create_jwt(user), "user": user}


@router.get("/auth/me")
def get_me(user: dict = Depends(get_current_user)):
    return user


@router.post("/auth/refresh")
def refresh_token(
    request: Request,
    user: dict = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Explicitly swap a login token for a fresh one. The browser doesn't need
    this — get_current_user hands back an X-Refreshed-Token header on its own
    once a token is past halfway — but it's kept for other clients.

    Re-runs the sign-in gate: someone whose access has been revoked since login
    can see out their current token's lifetime but can't extend it. Rejects
    personal access tokens, which must stay revocable: exchanging one here
    would mint a 30-day login token that revoking it could not take back.
    """
    if not AUTH_ENABLED:
        raise HTTPException(status_code=503, detail="Auth not configured (GOOGLE_CLIENT_ID not set)")

    if getattr(request.state, "token_scope", None) is not None:
        raise HTTPException(status_code=403, detail="API tokens can't be exchanged for a session token")

    if not email_authorised(session, user["email"]):
        raise HTTPException(status_code=403, detail="This Google account is not authorised")

    return {"access_token": create_jwt(user), "user": user}


@router.get("/auth/config")
def auth_config():
    """Let the frontend know whether auth is enabled and which client ID to use."""
    return {
        "enabled": AUTH_ENABLED,
        "client_id": GOOGLE_CLIENT_ID if AUTH_ENABLED else "",
    }
