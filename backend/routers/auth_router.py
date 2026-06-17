from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import SQLModel
from ..auth import (
    verify_google_token, create_jwt, get_current_user,
    GOOGLE_CLIENT_ID, ALLOWED_EMAIL, AUTH_ENABLED,
)

router = APIRouter(tags=["auth"])


class GoogleAuthRequest(SQLModel):
    credential: str


@router.post("/auth/google")
def google_auth(req: GoogleAuthRequest):
    if not AUTH_ENABLED:
        raise HTTPException(status_code=503, detail="Auth not configured (GOOGLE_CLIENT_ID not set)")
    try:
        user = verify_google_token(req.credential)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {e}")

    if ALLOWED_EMAIL and user["email"].lower() != ALLOWED_EMAIL:
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
