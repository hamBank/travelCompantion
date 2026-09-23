"""Travelers — who is physically *going* on a trip, separate from who may
view/edit it (TripMembership). See docs/plans/plan-17-travelers.md (D1-D9)
for the full design; docs/plans/plan-17a-traveler-model-api.md for this
sub-plan's exact API/test contract.

Every route is scoped under /trips/{trip_id}/travelers (no APIRouter prefix
— same "full path per route" convention as backend/routers/expenses.py) and
requires at least viewer access on the trip. The list/create/patch/delete
routes never touch profile_encrypted; only the .../profile routes decrypt or
encrypt anything, and only after document_crypto.require_configured() — see
backend/permissions.py:require_traveler_access for the D4 role matrix this
file defers to rather than re-implementing.
"""
from datetime import date, datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from .. import document_crypto, travelers as travelers_mod
from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role, require_traveler_access
from ..models import (
    Traveler, TravelerRead, TravelerCreate, TravelerUpdate,
    TravelerProfile, TravelerProfileUpdate, Trip, TripRole,
)

router = APIRouter()


def _traveler_read(t: Traveler) -> TravelerRead:
    return TravelerRead(
        id=t.id, trip_id=t.trip_id, user_email=t.user_email,
        display_name=t.display_name, age_band=t.age_band,
        passport_expiry=t.passport_expiry, has_profile=bool(t.profile_encrypted),
        created_at=t.created_at, updated_at=t.updated_at,
    )


def _require_own_trip(traveler: Traveler, trip_id: int) -> None:
    """A traveler id that belongs to a different trip than the one in the
    URL must 404, same as a nonexistent id — never leaks that the id exists
    elsewhere (mirrors require_trip_role's no-access-at-all 404 rule)."""
    if traveler.trip_id != trip_id:
        raise HTTPException(status_code=404, detail="Traveler not found")


def _age_reference_date(session: Session, trip_id: int) -> date:
    """Age is computed against the trip's start date, falling back to today
    when the trip is undated (D5) — used both for the response's
    age_at_trip_start and for recomputing the clear age_band on profile save."""
    trip = session.get(Trip, trip_id)
    if trip and trip.start_date:
        return trip.start_date.date()
    return datetime.utcnow().date()


def _profile_response(session: Session, traveler: Traveler) -> TravelerProfile:
    data = travelers_mod.decode_profile(traveler.profile_encrypted) if traveler.profile_encrypted else {}
    age = None
    dob_str = data.get("date_of_birth")
    if dob_str:
        try:
            dob = date.fromisoformat(dob_str)
            age = travelers_mod.age_at(dob, _age_reference_date(session, traveler.trip_id))
        except ValueError:
            age = None
    return TravelerProfile(**data, passport_expiry=traveler.passport_expiry, age_at_trip_start=age)


@router.get("/trips/{trip_id}/travelers", response_model=List[TravelerRead])
def list_travelers(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_trip_role(session, user, trip_id, TripRole.viewer)
    rows = session.exec(
        select(Traveler).where(Traveler.trip_id == trip_id).order_by(Traveler.display_name)
    ).all()
    return [_traveler_read(t) for t in rows]


@router.post("/trips/{trip_id}/travelers", response_model=TravelerRead, status_code=201)
def create_traveler(
    trip_id: int, body: TravelerCreate,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    role = require_trip_role(session, user, trip_id, TripRole.editor)
    email = user["email"].lower()

    if role == TripRole.owner:
        target_email = (body.user_email or "").strip().lower() or None
    else:
        # Editor: forced to their own email regardless of what was sent (D4)
        # — not an error, just overridden, same spirit as add_member's
        # existing "can't grant owner" guard elsewhere in this app.
        target_email = email

    if target_email:
        dup = session.exec(
            select(Traveler)
            .where(Traveler.trip_id == trip_id)
            .where(Traveler.user_email == target_email)
        ).first()
        if dup:
            raise HTTPException(status_code=409, detail="A traveler for this email already exists on this trip")

    traveler = Traveler(trip_id=trip_id, user_email=target_email, display_name=body.display_name)
    session.add(traveler)
    session.commit()
    session.refresh(traveler)
    return _traveler_read(traveler)


@router.patch("/trips/{trip_id}/travelers/{traveler_id}", response_model=TravelerRead)
def update_traveler(
    trip_id: int, traveler_id: int, body: TravelerUpdate,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    traveler, role = require_traveler_access(session, user, traveler_id, write=True)
    _require_own_trip(traveler, trip_id)

    data = body.model_dump(exclude_unset=True)
    if "user_email" in data:
        new_email = (data["user_email"] or "").strip().lower() or None
        if role != TripRole.owner and new_email != traveler.user_email:
            raise HTTPException(status_code=403, detail="Only the trip owner may change a traveler's linked account")
        if new_email:
            dup = session.exec(
                select(Traveler)
                .where(Traveler.trip_id == trip_id)
                .where(Traveler.user_email == new_email)
                .where(Traveler.id != traveler_id)
            ).first()
            if dup:
                raise HTTPException(status_code=409, detail="A traveler for this email already exists on this trip")
        data["user_email"] = new_email

    for field, value in data.items():
        setattr(traveler, field, value)
    traveler.updated_at = datetime.now(timezone.utc)
    session.add(traveler)
    session.commit()
    session.refresh(traveler)
    return _traveler_read(traveler)


@router.delete("/trips/{trip_id}/travelers/{traveler_id}", status_code=204)
def delete_traveler(
    trip_id: int, traveler_id: int,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    traveler, _role = require_traveler_access(session, user, traveler_id, write=True)
    _require_own_trip(traveler, trip_id)
    session.delete(traveler)
    session.commit()


@router.get("/trips/{trip_id}/travelers/{traveler_id}/profile", response_model=TravelerProfile)
def get_traveler_profile(
    trip_id: int, traveler_id: int,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    traveler, _role = require_traveler_access(session, user, traveler_id, write=False)
    _require_own_trip(traveler, trip_id)
    document_crypto.require_configured("Traveler profiles")
    if not traveler.profile_encrypted:
        raise HTTPException(status_code=404, detail="No profile stored")
    return _profile_response(session, traveler)


@router.put("/trips/{trip_id}/travelers/{traveler_id}/profile", response_model=TravelerProfile)
def put_traveler_profile(
    trip_id: int, traveler_id: int, body: TravelerProfileUpdate,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    traveler, _role = require_traveler_access(session, user, traveler_id, write=True)
    _require_own_trip(traveler, trip_id)
    document_crypto.require_configured("Traveler profiles")

    incoming = body.model_dump(exclude_unset=True)
    passport_expiry: Optional[datetime]
    has_passport_expiry = "passport_expiry" in incoming
    passport_expiry = incoming.pop("passport_expiry", None)

    existing = travelers_mod.decode_profile(traveler.profile_encrypted) if traveler.profile_encrypted else {}
    existing.update(incoming)   # merge, not replace (D3) — a put with only `phone` keeps passport_number etc.
    traveler.profile_encrypted = travelers_mod.encode_profile(existing)

    if has_passport_expiry:
        traveler.passport_expiry = passport_expiry

    dob_str = existing.get("date_of_birth")
    if dob_str:
        try:
            dob = date.fromisoformat(dob_str)
            traveler.age_band = travelers_mod.age_band(dob, _age_reference_date(session, trip_id))
        except ValueError:
            pass

    traveler.updated_at = datetime.now(timezone.utc)
    session.add(traveler)
    session.commit()
    session.refresh(traveler)
    return _profile_response(session, traveler)


@router.delete("/trips/{trip_id}/travelers/{traveler_id}/profile", status_code=204)
def delete_traveler_profile(
    trip_id: int, traveler_id: int,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    traveler, _role = require_traveler_access(session, user, traveler_id, write=True)
    _require_own_trip(traveler, trip_id)
    traveler.profile_encrypted = None
    traveler.age_band = None
    traveler.passport_expiry = None
    traveler.updated_at = datetime.now(timezone.utc)
    session.add(traveler)
    session.commit()
