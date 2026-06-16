from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import List
from ..database import get_session
from ..models import ItineraryItem, ItemCreate, ItemRead, ItemUpdate, Stop

router = APIRouter()


@router.get("/stops/{stop_id}/items", response_model=List[ItemRead])
def list_items(stop_id: int, session: Session = Depends(get_session)):
    if not session.get(Stop, stop_id):
        raise HTTPException(status_code=404, detail="Stop not found")
    return session.exec(
        select(ItineraryItem)
        .where(ItineraryItem.stop_id == stop_id)
        .order_by(ItineraryItem.scheduled_at)
    ).all()


@router.post("/stops/{stop_id}/items", response_model=ItemRead, status_code=201)
def create_item(stop_id: int, item_in: ItemCreate, session: Session = Depends(get_session)):
    if not session.get(Stop, stop_id):
        raise HTTPException(status_code=404, detail="Stop not found")
    item = ItineraryItem(**item_in.model_dump(), stop_id=stop_id)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.get("/items/{item_id}", response_model=ItemRead)
def get_item(item_id: int, session: Session = Depends(get_session)):
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.patch("/items/{item_id}", response_model=ItemRead)
def update_item(item_id: int, item_in: ItemUpdate, session: Session = Depends(get_session)):
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    for field, value in item_in.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, session: Session = Depends(get_session)):
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    session.delete(item)
    session.commit()
