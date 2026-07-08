"""Item attachments — boarding passes, booking PDFs, QR codes.

Stored as blobs directly in the DB (see ItemAttachment in models.py), not on
disk, so the app's single-database backup story keeps covering them and so
they're viewable at the gate without a separate file-serving path. Kept
deliberately simple — no thumbnails, no virus scanning, no async processing —
this is a personal travel-planning app, not a document management system.
"""
from typing import List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from sqlmodel import Session, select

from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_item_role
from ..models import ItemAttachment, ItemAttachmentRead, ItineraryItem, TripRole

router = APIRouter()

_MAX_SIZE = 10 * 1024 * 1024   # 10MB per file
_MAX_COUNT = 10                # attachments per item


@router.post("/items/{item_id}/attachments", response_model=ItemAttachmentRead, status_code=201)
async def upload_attachment(
    item_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    require_item_role(session, user, item_id, TripRole.editor)
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    existing = session.exec(
        select(ItemAttachment).where(ItemAttachment.item_id == item_id)
    ).all()
    if len(existing) >= _MAX_COUNT:
        raise HTTPException(status_code=400, detail=f"Max {_MAX_COUNT} attachments per item")

    content = await file.read()
    if len(content) > _MAX_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File too large (max {_MAX_SIZE // (1024 * 1024)}MB)",
        )

    attachment = ItemAttachment(
        item_id=item_id,
        filename=file.filename or "attachment",
        content_type=file.content_type or "application/octet-stream",
        size=len(content),
        data=content,
    )
    session.add(attachment)
    session.commit()
    session.refresh(attachment)
    return attachment


@router.get("/items/{item_id}/attachments", response_model=List[ItemAttachmentRead])
def list_attachments(
    item_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """List metadata only (no `data`) — see ItemAttachmentRead."""
    require_item_role(session, user, item_id, TripRole.viewer)
    return session.exec(
        select(ItemAttachment)
        .where(ItemAttachment.item_id == item_id)
        .order_by(ItemAttachment.created_at)
    ).all()


@router.get("/attachments/{attachment_id}")
def download_attachment(
    attachment_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    attachment = session.get(ItemAttachment, attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    require_item_role(session, user, attachment.item_id, TripRole.viewer)
    return Response(
        content=attachment.data,
        media_type=attachment.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{attachment.filename}"'},
    )


@router.delete("/attachments/{attachment_id}", status_code=204)
def delete_attachment(
    attachment_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    attachment = session.get(ItemAttachment, attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    require_item_role(session, user, attachment.item_id, TripRole.editor)
    session.delete(attachment)
    session.commit()
