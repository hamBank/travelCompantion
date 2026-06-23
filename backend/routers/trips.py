from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from sqlalchemy import nullslast
from typing import List
from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role, user_role_for_trip
from ..models import (
    Trip, TripCreate, TripRead, TripReadWithRole, TripUpdate,
    Stop, StopRead,
    ItineraryItem, ItemRead, ItemKind, ItemStatus,
    TripMembership, TripRole, MembershipRead, MembershipCreate,
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
    require_trip_role(session, user, trip_id, TripRole.owner)
    trip = session.get(Trip, trip_id)
    stops = session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()
    for stop in stops:
        for item in session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop.id)).all():
            session.delete(item)
        session.delete(stop)
    for m in session.exec(select(TripMembership).where(TripMembership.trip_id == trip_id)).all():
        session.delete(m)
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


# ── Timeline ──────────────────────────────────────────────────────────────────

class StopWithItems(StopRead):
    items: List[ItemRead] = []


class TripTimeline(TripReadWithRole):
    stops: List[StopWithItems] = []


@router.get("/{trip_id}/timeline", response_model=TripTimeline)
def trip_timeline(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    role = require_trip_role(session, user, trip_id, TripRole.viewer)
    trip = session.get(Trip, trip_id)
    trip_data = trip.model_dump()  # capture before any lazy-migration commit expires attributes

    stops = session.exec(
        select(Stop)
        .where(Stop.trip_id == trip_id)
        # Chronological by arrival, then earliest departure; undated stops fall to
        # the end, sort_order breaks remaining ties.
        .order_by(nullslast(Stop.arrive), nullslast(Stop.depart), Stop.sort_order)
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
