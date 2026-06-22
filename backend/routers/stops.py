from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
from ..database import get_session
from sqlmodel import SQLModel as _SQLModel
from ..auth import get_current_user
from ..permissions import require_trip_role, require_stop_role
from ..models import Stop, StopCreate, StopRead, StopUpdate, Trip, ItineraryItem, TripRole

router = APIRouter()


@router.get("/trips/{trip_id}/stops", response_model=List[StopRead])
def list_stops(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_trip_role(session, user, trip_id, TripRole.viewer)
    return session.exec(
        select(Stop).where(Stop.trip_id == trip_id).order_by(Stop.sort_order, Stop.arrive)
    ).all()


@router.post("/trips/{trip_id}/stops", response_model=StopRead, status_code=201)
def create_stop(trip_id: int, stop_in: StopCreate, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_trip_role(session, user, trip_id, TripRole.editor)
    stop = Stop(**stop_in.model_dump(), trip_id=trip_id)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop


@router.get("/stops/{stop_id}", response_model=StopRead)
def get_stop(stop_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_stop_role(session, user, stop_id, TripRole.viewer)
    return session.get(Stop, stop_id)


@router.patch("/stops/{stop_id}", response_model=StopRead)
def update_stop(stop_id: int, stop_in: StopUpdate, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_stop_role(session, user, stop_id, TripRole.editor)
    stop = session.get(Stop, stop_id)
    for field, value in stop_in.model_dump(exclude_unset=True).items():
        setattr(stop, field, value)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop


@router.delete("/stops/{stop_id}", status_code=204)
def delete_stop(stop_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_stop_role(session, user, stop_id, TripRole.editor)
    stop = session.get(Stop, stop_id)
    for item in session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop_id)).all():
        session.delete(item)
    session.delete(stop)
    session.commit()


class ReorderRequest(_SQLModel):
    sort_order: int


@router.patch("/stops/{stop_id}/reorder", response_model=StopRead)
def reorder_stop(stop_id: int, req: ReorderRequest, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_stop_role(session, user, stop_id, TripRole.editor)
    stop = session.get(Stop, stop_id)
    stop.sort_order = req.sort_order
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop
