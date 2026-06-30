"""Packing list: per-person + shared items, bags, and packed counts.

Visibility: a user sees their own items plus shared items (owner_email == "").
Permissions:
  * personal items  — the owner manages their own (any trip member)
  * shared items    — editor/owner only
  * bags (trip-wide) — editor/owner only
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role
from ..models import (
    Bag, BagCreate, BagUpdate, BagRead,
    PackingItem, PackingItemCreate, PackingItemUpdate, PackingItemRead,
    TripRole,
)

router = APIRouter()


def _email(user: dict) -> str:
    return (user.get("email") or "").lower()


def _visible(item: PackingItem, me: str) -> bool:
    return item.owner_email == "" or item.owner_email == me


def _clamp_packed(quantity: int, packed: int) -> int:
    return max(0, min(packed, quantity))


# ── Read ───────────────────────────────────────────────────────────────────────

@router.get("/trips/{trip_id}/packing")
def get_packing(
    trip_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    require_trip_role(session, user, trip_id, TripRole.viewer)
    me = _email(user)

    bags = session.exec(select(Bag).where(Bag.trip_id == trip_id)).all()
    all_items = session.exec(select(PackingItem).where(PackingItem.trip_id == trip_id)).all()
    items = [i for i in all_items if _visible(i, me)]
    items.sort(key=lambda i: (i.sort_order, i.id or 0))

    total = sum(i.quantity for i in items)
    packed = sum(i.packed_count for i in items)
    return {
        "bags": [BagRead(**b.model_dump()) for b in bags],
        "items": [PackingItemRead(**i.model_dump()) for i in items],
        "counts": {"total": total, "packed": packed},
    }


# ── Items ──────────────────────────────────────────────────────────────────────

@router.post("/trips/{trip_id}/packing", response_model=PackingItemRead)
def create_item(
    trip_id: int, body: PackingItemCreate,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    # Personal items: any member. Shared items: editor+.
    require_trip_role(session, user, trip_id,
                      TripRole.editor if body.shared else TripRole.viewer)
    qty = max(1, body.quantity)
    item = PackingItem(
        trip_id=trip_id,
        name=body.name,
        owner_email="" if body.shared else _email(user),
        bag_id=body.bag_id,
        quantity=qty,
        packed_count=_clamp_packed(qty, body.packed_count),
    )
    session.add(item)
    session.commit()
    session.refresh(item)
    return PackingItemRead(**item.model_dump())


def _get_writable_item(session: Session, user: dict, item_id: int) -> PackingItem:
    item = session.get(PackingItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Packing item not found")
    me = _email(user)
    if item.owner_email == "":
        # shared → editor+
        require_trip_role(session, user, item.trip_id, TripRole.editor)
    else:
        # personal → must be the owner (and still a member)
        require_trip_role(session, user, item.trip_id, TripRole.viewer)
        if item.owner_email != me:
            raise HTTPException(status_code=404, detail="Packing item not found")
    return item


@router.patch("/packing/{item_id}", response_model=PackingItemRead)
def update_item(
    item_id: int, body: PackingItemUpdate,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    item = _get_writable_item(session, user, item_id)
    data = body.model_dump(exclude_unset=True)

    if "shared" in data:
        # Toggling shared changes ownership; requires editor (shared write).
        require_trip_role(session, user, item.trip_id, TripRole.editor)
        item.owner_email = "" if data["shared"] else _email(user)
    for field in ("name", "bag_id", "quantity", "packed_count"):
        if field in data:
            setattr(item, field, data[field])
    if item.quantity < 1:
        item.quantity = 1
    item.packed_count = _clamp_packed(item.quantity, item.packed_count)

    session.add(item)
    session.commit()
    session.refresh(item)
    return PackingItemRead(**item.model_dump())


@router.delete("/packing/{item_id}", status_code=204)
def delete_item(
    item_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    item = _get_writable_item(session, user, item_id)
    session.delete(item)
    session.commit()


# ── Bags (trip-wide, editor+) ───────────────────────────────────────────────────

def _validate_parent(session: Session, bag: Bag, parent_id: Optional[int]) -> None:
    """Ensure parent_id is a valid, same-trip bag that won't create a cycle."""
    if parent_id is None:
        return
    if parent_id == bag.id:
        raise HTTPException(status_code=400, detail="A bag can't be its own parent")
    parent = session.get(Bag, parent_id)
    if not parent or parent.trip_id != bag.trip_id:
        raise HTTPException(status_code=400, detail="Parent bag not found on this trip")
    # Walk up from the proposed parent; if we reach `bag`, it'd be a cycle.
    seen, cur = set(), parent
    while cur is not None:
        if cur.id == bag.id:
            raise HTTPException(status_code=400, detail="That would nest a bag inside itself")
        if cur.id in seen:
            break
        seen.add(cur.id)
        cur = session.get(Bag, cur.parent_id) if cur.parent_id else None


@router.post("/trips/{trip_id}/bags", response_model=BagRead)
def create_bag(
    trip_id: int, body: BagCreate,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    require_trip_role(session, user, trip_id, TripRole.editor)
    bag = Bag(trip_id=trip_id, name=body.name)
    if body.parent_id is not None:
        _validate_parent(session, bag, body.parent_id)
        bag.parent_id = body.parent_id
    session.add(bag)
    session.commit()
    session.refresh(bag)
    return BagRead(**bag.model_dump())


@router.patch("/bags/{bag_id}", response_model=BagRead)
def update_bag(
    bag_id: int, body: BagUpdate,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    bag = session.get(Bag, bag_id)
    if not bag:
        raise HTTPException(status_code=404, detail="Bag not found")
    require_trip_role(session, user, bag.trip_id, TripRole.editor)
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"]:
        bag.name = data["name"]
    if "parent_id" in data:
        _validate_parent(session, bag, data["parent_id"])
        bag.parent_id = data["parent_id"]
    session.add(bag)
    session.commit()
    session.refresh(bag)
    return BagRead(**bag.model_dump())


@router.delete("/bags/{bag_id}", status_code=204)
def delete_bag(
    bag_id: int,
    session: Session = Depends(get_session),
    user: dict = Depends(get_current_user),
):
    bag = session.get(Bag, bag_id)
    if not bag:
        raise HTTPException(status_code=404, detail="Bag not found")
    require_trip_role(session, user, bag.trip_id, TripRole.editor)
    # Unassign items in this bag rather than deleting them.
    for it in session.exec(select(PackingItem).where(PackingItem.bag_id == bag_id)).all():
        it.bag_id = None
        session.add(it)
    # Promote child bags up to this bag's parent so they aren't orphaned.
    for child in session.exec(select(Bag).where(Bag.parent_id == bag_id)).all():
        child.parent_id = bag.parent_id
        session.add(child)
    session.commit()  # flush reassignments before removing the row (FK safety)
    session.delete(bag)
    session.commit()
