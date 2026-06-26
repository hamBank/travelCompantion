"""Per-user self-service endpoints."""
import os
import secrets

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..database import get_session
from ..auth import get_current_user
from ..models import UserImportToken

router = APIRouter()

_MAIL_DOMAIN = os.getenv("MAIL_DOMAIN", "tripplan.hups.club")


@router.get("/me/import-address")
def import_address(session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """The user's forwarding address (import+<token>@domain), generating it once."""
    email = user["email"].lower()
    tok = session.exec(select(UserImportToken).where(UserImportToken.user_email == email)).first()
    if not tok:
        tok = UserImportToken(user_email=email, token=secrets.token_urlsafe(9))
        session.add(tok); session.commit(); session.refresh(tok)
    return {"address": f"import+{tok.token}@{_MAIL_DOMAIN}", "domain": _MAIL_DOMAIN}
