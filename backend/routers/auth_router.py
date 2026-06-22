from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import SQLModel, Session, select
from ..database import get_session
from ..auth import (
    verify_google_token, create_jwt, get_current_user,
    GOOGLE_CLIENT_ID, ALLOWED_EMAIL, AUTH_ENABLED,
)
from ..models import TripMembership

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

    # Authorised to sign in if: this is the bootstrap admin (ALLOWED_EMAIL), or they
    # have been shared at least one trip (any TripMembership). When ALLOWED_EMAIL is
    # unset, anyone with a Google account may sign in (membership then gates access).
    email = user["email"].lower()
    if ALLOWED_EMAIL and email != ALLOWED_EMAIL:
        has_membership = session.exec(
            select(TripMembership).where(TripMembership.user_email == email)
        ).first()
        if not has_membership:
            raise HTTPException(status_code=403, detail="This Google account is not authorised")

    return {"access_token": create_jwt(user), "user": user}


@router.get("/auth/me")
def get_me(user: dict = Depends(get_current_user)):
    return user


@router.get("/auth/config")
def auth_config():
    """Let the frontend know whether auth is enabled and which client ID to use."""
    return {
        "enabled": AUTH_ENABLED,
        "client_id": GOOGLE_CLIENT_ID if AUTH_ENABLED else "",
    }
