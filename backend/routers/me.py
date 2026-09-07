"""Per-user self-service endpoints."""
import os
import secrets
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse
from sqlmodel import Session, SQLModel, select

from ..database import get_session
from ..auth import get_current_user, create_api_token
from ..models import (
    UserImportToken, IngestedEmail, IngestedEmailRead, ApiToken, ApiTokenRead,
)

router = APIRouter()


class ApiTokenRequest(SQLModel):
    # Lifetime in days, clamped to [1, API_TOKEN_EXPIRE_DAYS]. Omit for the default.
    days: Optional[int] = None
    label: Optional[str] = None   # optional human label to identify the token later


@router.post("/me/api-token")
def create_personal_api_token(
    body: Optional[ApiTokenRequest] = None,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """Mint a personal access token for programmatic (non-browser) API use.

    Call this once while signed in to the web app, then use the returned token
    as `Authorization: Bearer <token>` from a script or agent. It grants the
    same full account access as a login session — store it like a password. The
    token is revocable via DELETE /me/api-tokens/{id}. The full token string is
    returned **only here**, once — we store only its id for later revocation.
    See docs/programmatic-api.md.
    """
    token, jti, exp = create_api_token(user, body.days if body else None)
    row = ApiToken(
        jti=jti,
        user_email=user["email"].lower(),
        label=(body.label if body and body.label else ""),
        expires_at=exp,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return {
        "id": row.id,
        "token": token,
        "token_type": "bearer",
        "label": row.label,
        # Plain (non-"Z"-suffixed) ISO datetime, same as every other timestamp
        # in the API (including GET /me/api-tokens' own expires_at) — FastAPI's
        # default jsonable_encoder for a naive datetime, not hand-formatted.
        "expires_at": exp,
        "email": user["email"],
    }


@router.get("/me/api-tokens", response_model=List[ApiTokenRead])
def list_personal_api_tokens(
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """List this user's personal access tokens (never the secret) — newest
    first, including already-revoked ones (revoked_at set)."""
    rows = session.exec(
        select(ApiToken)
        .where(ApiToken.user_email == user["email"].lower())
        # id.desc() breaks ties: created_at is datetime.utcnow(), which can
        # collide at microsecond resolution for tokens minted back-to-back
        # (e.g. a script minting several) — id is monotonic and always distinct.
        .order_by(ApiToken.created_at.desc(), ApiToken.id.desc())
    ).all()
    return rows


@router.delete("/me/api-tokens/{token_id}", status_code=204)
def revoke_personal_api_token(
    token_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """Revoke one of this user's tokens — it stops authenticating immediately.
    Idempotent: revoking an already-revoked token is a no-op 204."""
    row = session.get(ApiToken, token_id)
    if not row or row.user_email != user["email"].lower():
        raise HTTPException(status_code=404, detail="Not found")
    if row.revoked_at is None:
        row.revoked_at = datetime.utcnow()
        session.add(row)
        session.commit()
    return Response(status_code=204)

_MAIL_DOMAIN = os.getenv("MAIL_DOMAIN", "tripplan.hups.club")
_APP_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MAIL_STORE = os.getenv("MAIL_STORE_DIR", os.path.join(_APP_ROOT, "mail_store"))


@router.get("/me/import-address")
def import_address(session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """The user's forwarding address (import+<token>@domain), generating it once."""
    email = user["email"].lower()
    tok = session.exec(select(UserImportToken).where(UserImportToken.user_email == email)).first()
    if not tok:
        tok = UserImportToken(user_email=email, token=secrets.token_urlsafe(9))
        session.add(tok); session.commit(); session.refresh(tok)
    return {"address": f"import+{tok.token}@{_MAIL_DOMAIN}", "domain": _MAIL_DOMAIN}


@router.post("/me/import-address/regenerate")
def regenerate_import_address(session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Rotate the user's forwarding address token — invalidates the old address
    immediately (anyone still forwarding to it gets an "unknown recipient
    token" error, same as docs/email-ingestion.md's manual-delete rotation
    path) and returns the new one."""
    email = user["email"].lower()
    tok = session.exec(select(UserImportToken).where(UserImportToken.user_email == email)).first()
    if tok:
        tok.token = secrets.token_urlsafe(9)
    else:
        tok = UserImportToken(user_email=email, token=secrets.token_urlsafe(9))
    session.add(tok); session.commit(); session.refresh(tok)
    return {"address": f"import+{tok.token}@{_MAIL_DOMAIN}", "domain": _MAIL_DOMAIN}


@router.get("/me/emails/{email_id}", response_model=IngestedEmailRead)
def get_ingested_email(
    email_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """Return metadata and extracted text body for one ingested email (owner only)."""
    row = session.get(IngestedEmail, email_id)
    if not row or row.resolved_user_email != user["email"].lower():
        raise HTTPException(status_code=404, detail="Not found")

    body_text = ""
    eml_path = os.path.join(_MAIL_STORE, row.storage_dir, "raw.eml")
    if os.path.exists(eml_path):
        try:
            from .documents import _text_from_eml
            with open(eml_path, "rb") as f:
                body_text = _text_from_eml(f.read())
        except Exception:
            pass

    return IngestedEmailRead(
        id=row.id,
        received_at=row.received_at,
        from_addr=row.from_addr,
        to_addr=row.to_addr,
        subject=row.subject,
        status=row.status,
        parse_error=row.parse_error,
        item_count=row.item_count,
        body_text=body_text,
    )


@router.get("/me/emails/{email_id}/raw")
def download_ingested_email(
    email_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """Serve the raw .eml file as a download (owner only)."""
    row = session.get(IngestedEmail, email_id)
    if not row or row.resolved_user_email != user["email"].lower():
        raise HTTPException(status_code=404, detail="Not found")

    eml_path = os.path.join(_MAIL_STORE, row.storage_dir, "raw.eml")
    if not os.path.exists(eml_path):
        raise HTTPException(status_code=404, detail="Raw email file not found on disk")

    return FileResponse(
        eml_path,
        media_type="message/rfc822",
        filename=f"email-{email_id}.eml",
    )


@router.get("/me/distance-totals")
def get_distance_totals(session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Lifetime distance traveled across every trip this account belongs to
    (any role), broken down by transport mode. Recomputed fresh on each call
    from current trip/item data (see backend/distance.py) — not an
    append-only ledger, so a deleted trip or edited item is reflected
    immediately, with no adjustment needed anywhere items are written."""
    from ..distance import compute_user_distance_totals
    by_mode = compute_user_distance_totals(session, user["email"])
    return {"by_mode": by_mode, "total_km": round(sum(by_mode.values()), 1)}
