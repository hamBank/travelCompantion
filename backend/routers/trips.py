import re
import secrets
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session, select
from sqlalchemy import nullslast, func
from typing import List
from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role, user_role_for_trip
from ..models import (
    Trip, TripCreate, TripRead, TripReadWithRole, TripUpdate,
    Stop, StopRead,
    ItineraryItem, ItemRead, ItemKind, ItemStatus, ItemAttachment,
    TripMembership, TripRole, MembershipRead, MembershipCreate,
    Bag, PackingItem, Expense,
)

router = APIRouter()


@router.get("/", response_model=List[TripReadWithRole])
def list_trips(session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    memberships = session.exec(
        select(TripMembership).where(TripMembership.user_email == user["email"].lower())
    ).all()
    by_trip = {m.trip_id: m.role for m in memberships}
    if by_trip:
        trips = session.exec(select(Trip).where(Trip.id.in_(by_trip.keys()))).all()
    else:
        # Auth disabled → no membership rows; fall back to all trips as owner.
        from ..auth import AUTH_ENABLED
        if AUTH_ENABLED:
            return []
        trips = session.exec(select(Trip)).all()
        by_trip = {t.id: TripRole.owner for t in trips}
    return [TripReadWithRole(**t.model_dump(), role=by_trip.get(t.id, TripRole.owner)) for t in trips]


@router.post("/", response_model=TripReadWithRole, status_code=201)
def create_trip(trip_in: TripCreate, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    trip = Trip(**trip_in.model_dump())
    session.add(trip)
    session.commit()
    session.refresh(trip)
    data = trip.model_dump()  # capture before the membership commit expires attributes
    session.add(TripMembership(trip_id=trip.id, user_email=user["email"].lower(), role=TripRole.owner))
    session.commit()
    return TripReadWithRole(**data, role=TripRole.owner)


@router.get("/{trip_id}", response_model=TripReadWithRole)
def get_trip(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    role = require_trip_role(session, user, trip_id, TripRole.viewer)
    trip = session.get(Trip, trip_id)
    return TripReadWithRole(**trip.model_dump(), role=role)


@router.patch("/{trip_id}", response_model=TripReadWithRole)
def update_trip(trip_id: int, trip_in: TripUpdate, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    role = require_trip_role(session, user, trip_id, TripRole.editor)
    trip = session.get(Trip, trip_id)
    for field, value in trip_in.model_dump(exclude_unset=True).items():
        setattr(trip, field, value)
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return TripReadWithRole(**trip.model_dump(), role=role)


@router.delete("/{trip_id}", status_code=204)
def delete_trip(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Deletes a trip and every row that FK-references it, explicitly and in
    dependency order — rather than relying on SQLAlchemy to infer it.
    TripMembership/Bag/PackingItem/ItemAttachment all have a real `trip_id`/
    `item_id` FK but no ORM Relationship() linking them back to Trip/
    ItineraryItem, so the unit-of-work has no dependency information to order
    their deletes against the parent row's delete. Without an explicit
    session.flush() per stage, this silently worked on SQLite (which doesn't
    enforce FKs by default) but 500s with a ForeignKeyViolation on Postgres —
    caught by the Postgres CI job (docs/postgres-migration.md).
    """
    require_trip_role(session, user, trip_id, TripRole.owner)
    trip = session.get(Trip, trip_id)

    # Unlike delete_stop/delete_item (which unlink expenses, since the money
    # was still spent), the whole trip is going away here — nothing to
    # preserve the expenses for. Delete before the stops/items they may
    # reference, same ordering-safety reasoning as everything else below.
    for expense in session.exec(select(Expense).where(Expense.trip_id == trip_id)).all():
        session.delete(expense)
    session.flush()

    for stop in session.exec(select(Stop).where(Stop.trip_id == trip_id)).all():
        for item in session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop.id)).all():
            for attachment in session.exec(select(ItemAttachment).where(ItemAttachment.item_id == item.id)).all():
                session.delete(attachment)
            session.flush()
            session.delete(item)
        session.delete(stop)
    session.flush()

    for m in session.exec(select(TripMembership).where(TripMembership.trip_id == trip_id)).all():
        session.delete(m)
    session.flush()

    # Packing items reference bags (bag_id); bags can nest via parent_id —
    # break any nesting first so deleting bags never trips a self-referential FK.
    for item in session.exec(select(PackingItem).where(PackingItem.trip_id == trip_id)).all():
        session.delete(item)
    session.flush()
    bags = session.exec(select(Bag).where(Bag.trip_id == trip_id)).all()
    for bag in bags:
        bag.parent_id = None
        session.add(bag)
    session.flush()
    for bag in bags:
        session.delete(bag)
    session.flush()

    session.delete(trip)
    session.commit()


# ── Sharing / members ──────────────────────────────────────────────────────────

@router.get("/{trip_id}/members", response_model=List[MembershipRead])
def list_members(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_trip_role(session, user, trip_id, TripRole.viewer)
    members = session.exec(select(TripMembership).where(TripMembership.trip_id == trip_id)).all()
    return [MembershipRead(user_email=m.user_email, role=m.role) for m in members]


@router.post("/{trip_id}/members", response_model=MembershipRead, status_code=201)
def add_member(trip_id: int, body: MembershipCreate, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_trip_role(session, user, trip_id, TripRole.owner)
    if body.role == TripRole.owner:
        raise HTTPException(status_code=400, detail="Cannot grant owner role; transfer ownership is not supported")
    email = body.user_email.strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")
    existing = session.exec(
        select(TripMembership)
        .where(TripMembership.trip_id == trip_id)
        .where(TripMembership.user_email == email)
    ).first()
    if existing:
        if existing.role == TripRole.owner:
            raise HTTPException(status_code=400, detail="Cannot change the owner's role")
        existing.role = body.role
        session.add(existing)
    else:
        existing = TripMembership(trip_id=trip_id, user_email=email, role=body.role)
        session.add(existing)
    session.commit()
    return MembershipRead(user_email=email, role=body.role)


@router.delete("/{trip_id}/members/{email}", status_code=204)
def remove_member(trip_id: int, email: str, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_trip_role(session, user, trip_id, TripRole.owner)
    m = session.exec(
        select(TripMembership)
        .where(TripMembership.trip_id == trip_id)
        .where(TripMembership.user_email == email.lower())
    ).first()
    if not m:
        raise HTTPException(status_code=404, detail="Member not found")
    if m.role == TripRole.owner:
        raise HTTPException(status_code=400, detail="Cannot remove the owner")
    session.delete(m)
    session.commit()


@router.get("/{trip_id}/export.pdf")
def export_trip_pdf(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Full trip as a PDF, one page per stop."""
    require_trip_role(session, user, trip_id, TripRole.viewer)
    from ..pdf_export import build_trip_pdf
    pdf = build_trip_pdf(session, trip_id)
    trip = session.get(Trip, trip_id)
    safe = re.sub(r'[^A-Za-z0-9 _-]', '', (trip.name or 'trip')).strip() or 'trip'
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe}.pdf"'},
    )


@router.get("/{trip_id}/calendar-url")
def get_calendar_url(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Path (not absolute URL — the frontend prepends location.origin) for
    this trip's public, tokenized iCal feed. Viewer access is enough to get
    the link since it grants no more than viewing already grants."""
    require_trip_role(session, user, trip_id, TripRole.viewer)
    from ..auth import create_ical_token
    token = create_ical_token(trip_id)
    return {"url": f"/calendar/{token}.ics"}


@router.get("/{trip_id}/share-token")
def get_share_token(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Current public-link state, if any. Owner-only — same gate as the
    member-management endpoints above, since a share link grants read access
    to the whole trip, same as adding a viewer member would."""
    require_trip_role(session, user, trip_id, TripRole.owner)
    trip = session.get(Trip, trip_id)
    token = trip.share_token
    return {"token": token, "url": f"/shared/{token}" if token else None}


@router.post("/{trip_id}/share-token")
def create_share_token(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """(Re)generate the trip's public read-only share link, replacing any
    previous token — the old link stops working immediately since lookups
    are by exact token match."""
    require_trip_role(session, user, trip_id, TripRole.owner)
    trip = session.get(Trip, trip_id)
    token = secrets.token_urlsafe(24)
    trip.share_token = token
    session.add(trip)
    session.commit()
    return {"token": token, "url": f"/shared/{token}"}


@router.delete("/{trip_id}/share-token", status_code=204)
def revoke_share_token(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Turn off the public link entirely (share_token -> None)."""
    require_trip_role(session, user, trip_id, TripRole.owner)
    trip = session.get(Trip, trip_id)
    trip.share_token = None
    session.add(trip)
    session.commit()


@router.get("/{trip_id}/date-warnings")
def trip_date_warnings(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Items whose date falls outside their stop's arrive→depart window."""
    require_trip_role(session, user, trip_id, TripRole.viewer)
    from ..validation import date_warnings
    return {"warnings": date_warnings(session, trip_id)}


# ── Timeline ──────────────────────────────────────────────────────────────────

class StopWithItems(StopRead):
    items: List[ItemRead] = []


class TripTimeline(TripReadWithRole):
    stops: List[StopWithItems] = []


def build_trip_timeline(session: Session, trip_id: int, role: TripRole) -> TripTimeline:
    """Assemble the full timeline payload for a trip. Shared by the
    authenticated GET /trips/{id}/timeline below and the public
    GET /shared/{token}/timeline (backend/routers/shared.py) — the public
    endpoint calls this with role forced to TripRole.viewer rather than
    duplicating the stop/item assembly (and the lazy accommodation-item
    migration it performs) a second time.
    """
    trip = session.get(Trip, trip_id)
    trip_data = trip.model_dump()  # capture before any lazy-migration commit expires attributes

    stops = session.exec(
        select(Stop)
        .where(Stop.trip_id == trip_id)
        # Chronological by arrival, then earliest departure; undated stops fall to
        # the end, sort_order breaks remaining ties.
        .order_by(nullslast(func.date(Stop.arrive)), nullslast(func.date(Stop.depart)), Stop.sort_order)
    ).all()

    stops_with_items = []
    needs_commit = False
    for stop in stops:
        raw_items = list(session.exec(
            select(ItineraryItem)
            .where(ItineraryItem.stop_id == stop.id)
            .order_by(nullslast(ItineraryItem.scheduled_at))
        ).all())

        # Lazy migration: if this stop has a legacy accommodation string but no
        # accommodation item yet, create the item now so it shows up immediately.
        if stop.accommodation and not any(i.kind == ItemKind.accommodation for i in raw_items):
            from ..importer import _combine_checkinout
            details: dict = {}
            if stop.accommodation_notes:
                details["description"] = stop.accommodation_notes
            ci = _combine_checkinout(stop.arrive, stop.check_in)
            if ci:
                details["checkin"] = ci
            co = _combine_checkinout(stop.depart, stop.check_out)
            if co:
                details["checkout"] = co
            new_item = ItineraryItem(
                stop_id=stop.id,
                kind=ItemKind.accommodation,
                name=stop.accommodation,
                link=stop.accommodation_link or "",
                scheduled_at=stop.arrive,
                status=ItemStatus.pending,
                details=details or None,
            )
            session.add(new_item)
            session.flush()
            raw_items.append(new_item)
            needs_commit = True

        stops_with_items.append(
            StopWithItems(**stop.model_dump(), items=[ItemRead(**i.model_dump()) for i in raw_items])
        )

    if needs_commit:
        session.commit()

    return TripTimeline(**trip_data, role=role, stops=stops_with_items)


@router.get("/{trip_id}/timeline", response_model=TripTimeline)
def trip_timeline(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    role = require_trip_role(session, user, trip_id, TripRole.viewer)
    return build_trip_timeline(session, trip_id, role)
