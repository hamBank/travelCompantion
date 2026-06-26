"""Inbound email → pending changes.

A local mail pipe (postfix → mail_ingest.py) POSTs the raw RFC822 message here
with a shared secret. We resolve the user from the +token in the recipient,
store the raw email + attachments for debugging/source-display, parse it with
the document parser, and create PendingChange rows (trip not yet assigned — the
user picks the trip at review). The endpoint authenticates the *pipe*, never the
email author; everything it produces is pending until a human applies it.
"""
import os
import re
import hmac
import uuid
from email import message_from_bytes
from email.policy import default as email_default

from fastapi import APIRouter, Request, Depends
from sqlmodel import Session, select

from ..database import get_session
from ..models import IngestedEmail, UserImportToken, ItemKind

router = APIRouter()

_INGEST_SECRET = os.getenv("MAIL_INGEST_SECRET", "")
_APP_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MAIL_STORE = os.getenv("MAIL_STORE_DIR", os.path.join(_APP_ROOT, "mail_store"))


def _token_from_recipient(addr: str) -> str:
    """import+<token>@domain → <token> (case-preserving)."""
    if not addr:
        return ""
    local = addr.strip().split("@", 1)[0]
    m = re.search(r"\+([^+@]+)$", local)
    return m.group(1) if m else ""


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", (name or "attachment"))[:120] or "attachment"


def _store_email(raw: bytes, attachments) -> str:
    """Write raw.eml + attachments under a fresh uuid dir; return the dir name."""
    from .documents import _attachments_from_eml  # noqa: F401 (kept for symmetry)
    dirname = uuid.uuid4().hex
    full = os.path.join(_MAIL_STORE, dirname)
    os.makedirs(full, exist_ok=True)
    with open(os.path.join(full, "raw.eml"), "wb") as f:
        f.write(raw)
    for i, (fn, _ctype, data) in enumerate(attachments):
        with open(os.path.join(full, f"{i:02d}_{_safe_name(fn)}"), "wb") as f:
            f.write(data)
    return dirname


def parse_ingested(session: Session, ingested: IngestedEmail, raw: bytes, attachments):
    """Best-effort parse of a stored email into PendingChange rows."""
    from .documents import _text_from_eml, _build_prompt, _call_claude, build_pending_changes
    import base64

    if not os.getenv("ANTHROPIC_API_KEY", ""):
        ingested.status = "received"
        ingested.parse_error = "parser not configured"
        session.add(ingested); session.commit()
        return []

    doc_text = _text_from_eml(raw)
    pdf_b64 = None
    for fn, ctype, data in attachments:
        if fn.lower().endswith(".pdf") or "pdf" in (ctype or ""):
            pdf_b64 = base64.standard_b64encode(data).decode()
            break

    try:
        kinds = [k.value for k in ItemKind]
        parsed = _call_claude(_build_prompt([], kinds), pdf_b64, doc_text)
        pcs = build_pending_changes(
            session, ingested.resolved_user_email, None, [], parsed,
            source="email", source_email_id=ingested.id,
        )
        ingested.status = "parsed"
        ingested.item_count = len(pcs)
        session.add(ingested); session.commit()
        return pcs
    except Exception as e:  # never let a parse failure lose the email
        ingested.status = "error"
        ingested.parse_error = str(e)[:500]
        session.add(ingested); session.commit()
        return []


@router.post("/ingest/email")
async def ingest_email(request: Request, session: Session = Depends(get_session)):
    # Authenticate the local pipe, not the email author.
    secret = request.headers.get("X-Ingest-Secret", "")
    if not _INGEST_SECRET or not hmac.compare_digest(secret, _INGEST_SECRET):
        # 202 even on bad secret would hide misconfiguration; 403 is fine here
        # because the endpoint is localhost-only (never proxied by Apache).
        return _json(403, {"detail": "forbidden"})

    raw = await request.body()
    if not raw:
        return _json(400, {"detail": "empty message"})

    msg = message_from_bytes(raw, policy=email_default)
    # Prefer the explicit recipient the pipe passes (postfix ${recipient}); fall
    # back to the headers postfix adds on local delivery, then the message To.
    to_addr = (
        request.headers.get("X-Original-To")
        or msg.get("X-Original-To")
        or msg.get("Delivered-To")
        or msg.get("to")
        or ""
    )
    subject = (msg.get("subject") or "").strip()
    from_addr = (msg.get("from") or "").strip()

    token = _token_from_recipient(to_addr)
    resolved = ""
    if token:
        row = session.exec(select(UserImportToken).where(UserImportToken.token == token)).first()
        if row:
            resolved = row.user_email

    from .documents import _attachments_from_eml
    attachments = _attachments_from_eml(raw)
    storage_dir = _store_email(raw, attachments)

    ingested = IngestedEmail(
        from_addr=from_addr[:300], to_addr=to_addr[:300], subject=subject[:500],
        storage_dir=storage_dir, resolved_user_email=resolved,
        status="received" if resolved else "error",
        parse_error="" if resolved else "unknown recipient token",
    )
    session.add(ingested); session.commit(); session.refresh(ingested)

    items = 0
    if resolved:
        pcs = parse_ingested(session, ingested, raw, attachments)
        items = len(pcs)

    # Always 202 to the pipe; details are for logs/debugging only.
    return _json(202, {"id": ingested.id, "resolved": bool(resolved), "items": items})


def _json(status, body):
    from fastapi.responses import JSONResponse
    return JSONResponse(body, status_code=status)
