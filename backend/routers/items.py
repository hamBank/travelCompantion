from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from sqlalchemy import nullslast
from typing import List
import os, httpx
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
        .order_by(nullslast(ItineraryItem.scheduled_at))
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


_PLACES_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")
_PLACES_BASE = "https://maps.googleapis.com/maps/api/place"

@router.get("/items/{item_id}/enrich")
def enrich_item(item_id: int, session: Session = Depends(get_session)):
    if not _PLACES_KEY:
        raise HTTPException(status_code=503, detail="Google Places API not configured")
    item = session.get(ItineraryItem, item_id)
    if not item or item.kind not in ("accommodation", "restaurant"):
        raise HTTPException(status_code=404, detail="Item not found or not enrichable")

    details = item.details or {}
    query = item.name
    if details.get("location"):
        query += " " + details["location"]

    with httpx.Client(timeout=8) as client:
        # 1. Find the place
        search = client.get(f"{_PLACES_BASE}/findplacefromtext/json", params={
            "input": query,
            "inputtype": "textquery",
            "fields": "place_id",
            "key": _PLACES_KEY,
        }).json()
        candidates = search.get("candidates", [])
        if not candidates:
            raise HTTPException(status_code=404, detail="Place not found")

        # 2. Get place details
        place_id = candidates[0]["place_id"]
        det = client.get(f"{_PLACES_BASE}/details/json", params={
            "place_id": place_id,
            "fields": "name,formatted_address,formatted_phone_number,international_phone_number,website,editorial_summary",
            "key": _PLACES_KEY,
        }).json().get("result", {})

    suggestions = {}
    if det.get("formatted_address"):
        suggestions["location"] = det["formatted_address"]
    phone = det.get("formatted_phone_number") or det.get("international_phone_number")
    if phone:
        suggestions["contact_phone"] = phone
    if det.get("website"):
        suggestions["website"] = det["website"]
    if det.get("editorial_summary", {}).get("overview"):
        suggestions["description"] = det["editorial_summary"]["overview"]

    return suggestions
