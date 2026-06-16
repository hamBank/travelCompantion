from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
from ..database import get_session
from ..models import (
    Trip, TripCreate, TripRead, TripUpdate,
    Stop, StopRead,
    ItineraryItem, ItemRead,
)

router = APIRouter()


@router.get("/", response_model=List[TripRead])
def list_trips(session: Session = Depends(get_session)):
    return session.exec(select(Trip)).all()


@router.post("/", response_model=TripRead, status_code=201)
def create_trip(trip_in: TripCreate, session: Session = Depends(get_session)):
    trip = Trip(**trip_in.model_dump())
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return trip


@router.get("/{trip_id}", response_model=TripRead)
def get_trip(trip_id: int, session: Session = Depends(get_session)):
    trip = session.get(Trip, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    return trip


@router.patch("/{trip_id}", response_model=TripRead)
def update_trip(trip_id: int, trip_in: TripUpdate, session: Session = Depends(get_session)):
    trip = session.get(Trip, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    for field, value in trip_in.model_dump(exclude_unset=True).items():
        setattr(trip, field, value)
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return trip


@router.delete("/{trip_id}", status_code=204)
def delete_trip(trip_id: int, session: Session = Depends(get_session)):
    trip = session.get(Trip, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    stops = session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()
    for stop in stops:
        for item in session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop.id)).all():
            session.delete(item)
        session.delete(stop)
    session.delete(trip)
    session.commit()


# ── Timeline ──────────────────────────────────────────────────────────────────

class StopWithItems(StopRead):
    items: List[ItemRead] = []


class TripTimeline(TripRead):
    stops: List[StopWithItems] = []


@router.get("/{trip_id}/timeline", response_model=TripTimeline)
def trip_timeline(trip_id: int, session: Session = Depends(get_session)):
    trip = session.get(Trip, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")

    stops = session.exec(
        select(Stop)
        .where(Stop.trip_id == trip_id)
        .order_by(Stop.sort_order, Stop.arrive)
    ).all()

    stops_with_items = []
    for stop in stops:
        raw_items = session.exec(
            select(ItineraryItem)
            .where(ItineraryItem.stop_id == stop.id)
            .order_by(ItineraryItem.scheduled_at)
        ).all()
        stops_with_items.append(
            StopWithItems(**stop.model_dump(), items=[ItemRead(**i.model_dump()) for i in raw_items])
        )

    return TripTimeline(**trip.model_dump(), stops=stops_with_items)
