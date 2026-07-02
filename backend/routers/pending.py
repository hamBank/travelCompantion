"""Pending-change review: list / edit / apply / discard.

Imports (and later, inbound email) land here as PendingChange rows instead of
writing items directly. A logged-in editor reviews each one and applies it —
applying routes through the same item create/update logic the normal endpoints
use, so trip permissions are always enforced at apply time.
"""
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from sqlalchemy.orm.attributes import flag_modified

from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role, require_stop_role
from ..models import (
    PendingChange, PendingChangeRead, PendingChangeUpdate, PendingStatus,
    ItineraryItem, ItemRead, ItemCreate, ItemUpdate, Stop, TripRole, ItemKind,
)
from .items import record_item_history, _item_snapshot

router = APIRouter()


def _owned(session: Session, user: dict, pc_id: int) -> PendingChange:
    pc = session.get(PendingChange, pc_id)
    if not pc or pc.created_by != user["email"].lower():
        raise HTTPException(status_code=404, detail="Pending change not found")
    return pc


@router.get("/pending", response_model=List[PendingChangeRead])
def list_pending(
    trip_id: Optional[int] = None,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """The current user's pending changes (newest first).

    With ?trip_id=N, returns that trip's pending plus any not-yet-assigned ones
    (trip_id is null until the user picks a trip).
    """
    q = (
        select(PendingChange)
        .where(PendingChange.created_by == user["email"].lower())
        .where(PendingChange.status == PendingStatus.pending)
    )
    rows = session.exec(q.order_by(PendingChange.created_at.desc())).all()
    if trip_id is not None:
        rows = [r for r in rows if r.trip_id in (trip_id, None)]
    return rows


@router.patch("/pending/{pc_id}", response_model=PendingChangeRead)
def update_pending(
    pc_id: int,
    body: PendingChangeUpdate,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    """Edit a pending change before applying (trip/stop/kind/payload)."""
    pc = _owned(session, user, pc_id)
    if pc.status != PendingStatus.pending:
        raise HTTPException(status_code=409, detail="Already decided")

    data = body.model_dump(exclude_unset=True)
    if "trip_id" in data and data["trip_id"] is not None:
        require_trip_role(session, user, data["trip_id"], TripRole.editor)
        if data["trip_id"] != pc.trip_id:
            # Changing trip invalidates the stop choice and any update match.
            pc.suggested_stop_id = None
            pc.op = "create"
            pc.target_item_id = None
            pc.diff = None
        pc.trip_id = data["trip_id"]
    if "suggested_stop_id" in data:
        pc.suggested_stop_id = data["suggested_stop_id"]
    if "kind" in data and data["kind"]:
        pc.kind = data["kind"]
    if "payload" in data and data["payload"] is not None:
        pc.payload = data["payload"]
        flag_modified(pc, "payload")
    session.add(pc)
    session.commit()
    session.refresh(pc)
    return pc


@router.post("/pending/{pc_id}/apply", response_model=ItemRead)
def apply_pending(
    pc_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    pc = _owned(session, user, pc_id)
    if pc.status != PendingStatus.pending:
        raise HTTPException(status_code=409, detail="Already decided")
    if not pc.trip_id:
        raise HTTPException(status_code=400, detail="Assign a trip first")
    if not pc.suggested_stop_id:
        raise HTTPException(status_code=400, detail="Assign a stop first")

    stop = session.get(Stop, pc.suggested_stop_id)
    if not stop or stop.trip_id != pc.trip_id:
        raise HTTPException(status_code=400, detail="Stop does not belong to the chosen trip")
    require_stop_role(session, user, pc.suggested_stop_id, TripRole.editor)

    p = pc.payload or {}
    before_snap = None

    if pc.op == "update" and pc.target_item_id:
        item = session.get(ItineraryItem, pc.target_item_id)
        if not item:
            raise HTTPException(status_code=404, detail="Target item no longer exists")

        before_snap = _item_snapshot(item)
        diff_after = (pc.diff or {}).get("after", {}) if pc.diff is not None else None

        if diff_after is not None:
            # Diff was computed: apply granular field-by-field updates.
            # For passengers/participants we re-merge against the CURRENT item value
            # at apply time — not the stored diff — because another pending change may
            # have been applied since the diff was computed.
            from ..routers.documents import _PASSENGER_FIELDS, _merge_field, _val_eq

            scalar_keys = {"name", "scheduled_at", "link", "cost", "notes"}
            for f in scalar_keys:
                if f in diff_after:
                    setattr(item, f, diff_after[f])

            merged_details = dict(item.details or {})
            new_details = p.get("details") or {}

            # Apply diff keys into details, re-merging passenger/participant arrays live.
            for k, v in diff_after.items():
                if k in scalar_keys:
                    continue
                current = merged_details.get(k)
                if k in _PASSENGER_FIELDS and current and not _val_eq(current, v):
                    merged_details[k] = _merge_field(current, v)
                else:
                    merged_details[k] = v

            # Fill new detail keys from the payload that weren't in the existing record.
            for k, v in new_details.items():
                if k not in merged_details or not merged_details[k]:
                    merged_details[k] = v

            item.details = merged_details
            flag_modified(item, "details")
        else:
            # No diff — apply payload wholesale (original behaviour, e.g. manual edits).
            fields = {k: p[k] for k in ("name", "scheduled_at", "link", "cost", "notes", "details") if k in p}
            iu = ItemUpdate(kind=pc.kind, **fields)
            for field, value in iu.model_dump(exclude_unset=True).items():
                setattr(item, field, value)
                if field == "details":
                    flag_modified(item, "details")
        session.add(item)
    else:
        ic = ItemCreate(
            kind=pc.kind,
            name=(p.get("name") or "Imported item"),
            scheduled_at=p.get("scheduled_at") or None,
            link=p.get("link") or "",
            cost=p.get("cost") or "",
            notes=p.get("notes") or "",
            status="pending",
            details=p.get("details") or None,
        )
        item = ItineraryItem(**ic.model_dump(), stop_id=pc.suggested_stop_id)
        session.add(item)

    pc.status = PendingStatus.applied
    pc.decided_at = datetime.now(timezone.utc).replace(tzinfo=None)
    pc.decided_by = user["email"].lower()
    session.add(pc)
    session.commit()
    session.refresh(item)

    # Record history — op mirrors the pending change op; source comes from the PC
    history_before = before_snap if pc.op == "update" else None
    record_item_history(session, item, pc.op, user["email"],
                        before=history_before, source=pc.source)
    session.commit()

    from ..metrics import pending_decided
    pending_decided.labels(decision="applied").inc()
    return item


@router.post("/pending/{pc_id}/discard", status_code=204)
def discard_pending(
    pc_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    pc = _owned(session, user, pc_id)
    if pc.status == PendingStatus.pending:
        pc.status = PendingStatus.discarded
        pc.decided_at = datetime.now(timezone.utc).replace(tzinfo=None)
        pc.decided_by = user["email"].lower()
        session.add(pc)
        session.commit()
        from ..metrics import pending_decided
        pending_decided.labels(decision="discarded").inc()


def create_pending_from_parse(
    session: Session, user_email: str, trip_id: Optional[int],
    item: dict, suggested_stop_id: Optional[int],
    confidence: str = "low", match_reason: str = "",
    op: str = "create", target_item_id: Optional[int] = None,
    diff: Optional[dict] = None, source: str = "upload",
    source_email_id: Optional[int] = None,
) -> PendingChange:
    """Persist one parsed item as a PendingChange (shared by upload/email)."""
    kind = item.get("kind")
    try:
        kind_enum = ItemKind(kind)
    except ValueError:
        kind_enum = ItemKind.note
    pc = PendingChange(
        created_by=user_email.lower(),
        source=source,
        source_email_id=source_email_id,
        trip_id=trip_id,
        op=op,
        target_item_id=target_item_id,
        suggested_stop_id=suggested_stop_id,
        kind=kind_enum,
        payload={
            "name": item.get("name") or "Imported item",
            "scheduled_at": item.get("scheduled_at") or None,
            "cost": item.get("cost") or "",
            "link": item.get("link") or "",
            "notes": item.get("notes") or "",
            "details": item.get("details") or {},
        },
        diff=diff,
        confidence=confidence or "low",
        match_reason=match_reason or "",
    )
    session.add(pc)
    session.commit()
    session.refresh(pc)
    return pc
