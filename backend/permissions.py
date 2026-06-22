"""Per-trip authorization helpers.

Access is granted via TripMembership rows keyed by the user's email (which is the
Google identity / JWT subject). Roles, lowest→highest: viewer < editor < owner.

When auth is disabled (no GOOGLE_CLIENT_ID) every request is treated as owner so
local development behaves as before.
"""
from typing import Optional
from fastapi import HTTPException
from sqlmodel import Session, select

from .auth import AUTH_ENABLED
from .models import (
    Trip, Stop, ItineraryItem, TripMembership, TripRole, ROLE_RANK,
)


def user_role_for_trip(session: Session, email: str, trip_id: int) -> Optional[TripRole]:
    """Return the user's role on a trip, or None if they have no access."""
    if not AUTH_ENABLED:
        return TripRole.owner
    m = session.exec(
        select(TripMembership)
        .where(TripMembership.trip_id == trip_id)
        .where(TripMembership.user_email == email.lower())
    ).first()
    return m.role if m else None


def require_trip_role(session: Session, user: dict, trip_id: int, minimum: TripRole) -> TripRole:
    """Ensure the trip exists and the user has at least `minimum` role.

    Raises 404 if the trip doesn't exist, 403 if the user lacks sufficient access.
    Returns the user's actual role.
    """
    if not session.get(Trip, trip_id):
        raise HTTPException(status_code=404, detail="Trip not found")
    role = user_role_for_trip(session, user["email"], trip_id)
    if role is None or ROLE_RANK[role] < ROLE_RANK[minimum]:
        # 404 (not 403) when the user has no access at all — don't leak existence.
        if role is None:
            raise HTTPException(status_code=404, detail="Trip not found")
        raise HTTPException(status_code=403, detail=f"Requires {minimum.value} access")
    return role


def trip_id_for_stop(session: Session, stop_id: int) -> int:
    stop = session.get(Stop, stop_id)
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    return stop.trip_id


def trip_id_for_item(session: Session, item_id: int) -> int:
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return trip_id_for_stop(session, item.stop_id)


def require_stop_role(session: Session, user: dict, stop_id: int, minimum: TripRole) -> TripRole:
    return require_trip_role(session, user, trip_id_for_stop(session, stop_id), minimum)


def require_item_role(session: Session, user: dict, item_id: int, minimum: TripRole) -> TripRole:
    return require_trip_role(session, user, trip_id_for_item(session, item_id), minimum)
