"""Per-user self-service endpoints."""
import os
import secrets

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session
from ..auth import get_current_user
from ..models import UserImportToken, IngestedEmail, IngestedEmailRead

router = APIRouter()

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
