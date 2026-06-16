from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
from ..database import get_session
from sqlmodel import SQLModel as _SQLModel
from ..models import Stop, StopCreate, StopRead, StopUpdate, Trip

router = APIRouter()


@router.get("/trips/{trip_id}/stops", response_model=List[StopRead])
def list_stops(trip_id: int, session: Session = Depends(get_session)):
    if not session.get(Trip, trip_id):
        raise HTTPException(status_code=404, detail="Trip not found")
    return session.exec(
        select(Stop).where(Stop.trip_id == trip_id).order_by(Stop.sort_order, Stop.arrive)
    ).all()


@router.post("/trips/{trip_id}/stops", response_model=StopRead, status_code=201)
def create_stop(trip_id: int, stop_in: StopCreate, session: Session = Depends(get_session)):
    if not session.get(Trip, trip_id):
        raise HTTPException(status_code=404, detail="Trip not found")
    stop = Stop(**stop_in.model_dump(), trip_id=trip_id)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop


@router.get("/stops/{stop_id}", response_model=StopRead)
def get_stop(stop_id: int, session: Session = Depends(get_session)):
    stop = session.get(Stop, stop_id)
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    return stop


@router.patch("/stops/{stop_id}", response_model=StopRead)
def update_stop(stop_id: int, stop_in: StopUpdate, session: Session = Depends(get_session)):
    stop = session.get(Stop, stop_id)
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    for field, value in stop_in.model_dump(exclude_unset=True).items():
        setattr(stop, field, value)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop


@router.delete("/stops/{stop_id}", status_code=204)
def delete_stop(stop_id: int, session: Session = Depends(get_session)):
    stop = session.get(Stop, stop_id)
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    session.delete(stop)
    session.commit()


class ReorderRequest(_SQLModel):
    sort_order: int


@router.patch("/stops/{stop_id}/reorder", response_model=StopRead)
def reorder_stop(stop_id: int, req: ReorderRequest, session: Session = Depends(get_session)):
    stop = session.get(Stop, stop_id)
    if not stop:
        raise HTTPException(status_code=404, detail="Stop not found")
    stop.sort_order = req.sort_order
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop
