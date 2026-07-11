"""The document vault — a user's own passport/licence/visa scans, encrypted
at rest. Never trip-scoped: every route is gated on
document.user_email == current user only, no require_trip_role/require_item_role
anywhere in this file, and never reachable via a share token.

See docs/plans/plan-12a-document-vault-crud.md for the full design rationale.
Deliberately NOT named documents.py — that name is already taken by the
unrelated router that parses uploaded booking PDFs into PendingChange rows.
"""
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from sqlmodel import SQLModel, Session, select

from ..database import get_session
from ..auth import get_current_user
from .. import document_crypto
from ..document_crypto import encrypt_bytes, decrypt_bytes, DocumentVaultNotConfigured
from ..models import UserDocument, UserDocumentRead, UserDocumentFile, UserDocumentFileRead

router = APIRouter()

_MAX_SIZE = 10 * 1024 * 1024   # 10MB per file
_MAX_COUNT = 10                # files per document


def _require_vault_configured():
    # Every vault route that could touch encrypt/decrypt 503s uniformly when
    # the key is unset, rather than only the specific field/route that would
    # have needed it — simpler to reason about than a partial-503 surface.
    if not document_crypto.DOCUMENT_ENCRYPTION_KEY:
        raise HTTPException(status_code=503, detail="Document vault not configured (set DOCUMENT_ENCRYPTION_KEY)")


def _owned_document(session: Session, user: dict, doc_id: int) -> UserDocument:
    doc = session.get(UserDocument, doc_id)
    if not doc or doc.user_email != user["email"].lower():
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


class UserDocumentWrite(SQLModel):
    doc_type: str
    label: str = ""
    country: str = ""
    document_number: Optional[str] = None
    issued_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    notes: str = ""


class UserDocumentPatch(SQLModel):
    doc_type: Optional[str] = None
    label: Optional[str] = None
    country: Optional[str] = None
    document_number: Optional[str] = None
    issued_date: Optional[datetime] = None
    expiry_date: Optional[datetime] = None
    notes: Optional[str] = None


@router.get("/me/documents", response_model=List[UserDocumentRead])
def list_documents(session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    email = user["email"].lower()
    return session.exec(
        select(UserDocument).where(UserDocument.user_email == email).order_by(UserDocument.created_at)
    ).all()


@router.post("/me/documents", response_model=UserDocumentRead, status_code=201)
def create_document(
    body: UserDocumentWrite,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    _require_vault_configured()

    data = body.model_dump()
    document_number = data.pop("document_number", None)
    doc = UserDocument(user_email=user["email"].lower(), **data)
    if document_number:
        doc.document_number_encrypted = encrypt_bytes(document_number.encode())
    session.add(doc)
    session.commit()
    session.refresh(doc)
    return doc


@router.get("/me/documents/{doc_id}", response_model=UserDocumentRead)
def get_document(doc_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    return _owned_document(session, user, doc_id)


@router.get("/me/documents/{doc_id}/number")
def get_document_number(doc_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    _require_vault_configured()
    doc = _owned_document(session, user, doc_id)
    if not doc.document_number_encrypted:
        raise HTTPException(status_code=404, detail="No document number stored")
    return {"document_number": decrypt_bytes(doc.document_number_encrypted).decode()}


@router.patch("/me/documents/{doc_id}", response_model=UserDocumentRead)
def update_document(
    doc_id: int,
    body: UserDocumentPatch,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    _require_vault_configured()
    doc = _owned_document(session, user, doc_id)
    data = body.model_dump(exclude_unset=True)
    document_number = data.pop("document_number", "__unset__")

    for k, v in data.items():
        setattr(doc, k, v)

    if document_number != "__unset__":
        doc.document_number_encrypted = encrypt_bytes(document_number.encode()) if document_number else None

    doc.updated_at = datetime.utcnow()
    session.add(doc)
    session.commit()
    session.refresh(doc)
    return doc


@router.delete("/me/documents/{doc_id}", status_code=204)
def delete_document(doc_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    doc = _owned_document(session, user, doc_id)
    files = session.exec(select(UserDocumentFile).where(UserDocumentFile.document_id == doc_id)).all()
    for f in files:
        session.delete(f)
    session.flush()
    session.delete(doc)
    session.commit()


@router.post("/me/documents/{doc_id}/files", response_model=UserDocumentFileRead, status_code=201)
async def upload_document_file(
    doc_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    _require_vault_configured()
    doc = _owned_document(session, user, doc_id)

    existing = session.exec(select(UserDocumentFile).where(UserDocumentFile.document_id == doc.id)).all()
    if len(existing) >= _MAX_COUNT:
        raise HTTPException(status_code=400, detail=f"Max {_MAX_COUNT} files per document")

    content = await file.read()
    if len(content) > _MAX_SIZE:
        raise HTTPException(status_code=413, detail=f"File too large (max {_MAX_SIZE // (1024 * 1024)}MB)")

    doc_file = UserDocumentFile(
        document_id=doc.id,
        filename=file.filename or "document",
        content_type=file.content_type or "application/octet-stream",
        size=len(content),
        data_encrypted=encrypt_bytes(content),
    )
    session.add(doc_file)
    session.commit()
    session.refresh(doc_file)
    return doc_file


@router.get("/me/documents/{doc_id}/files/{file_id}")
def download_document_file(
    doc_id: int,
    file_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    _require_vault_configured()
    _owned_document(session, user, doc_id)
    doc_file = session.get(UserDocumentFile, file_id)
    if not doc_file or doc_file.document_id != doc_id:
        raise HTTPException(status_code=404, detail="File not found")

    content = decrypt_bytes(doc_file.data_encrypted)
    return Response(
        content=content,
        media_type=doc_file.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{doc_file.filename}"'},
    )


@router.delete("/me/documents/{doc_id}/files/{file_id}", status_code=204)
def delete_document_file(
    doc_id: int,
    file_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    _owned_document(session, user, doc_id)
    doc_file = session.get(UserDocumentFile, file_id)
    if not doc_file or doc_file.document_id != doc_id:
        raise HTTPException(status_code=404, detail="File not found")
    session.delete(doc_file)
    session.commit()
