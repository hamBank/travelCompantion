"""Public, tokenized iCal feed — GET /calendar/{token}.ics.

Deliberately unauthenticated: this is the endpoint a calendar app (Google
Calendar, Apple Calendar, etc.) polls directly with no Bearer token, so it
must be reachable without one. Access control is entirely the token itself
(see backend/auth.py's create_ical_token/verify_ical_token) — that's why
"/calendar/" is added to _PUBLIC_PREFIXES in backend/main.py's auth
middleware allowlist.

Both an invalid/forged token and a token for a trip that's since been
deleted return a plain 404 — never a distinguishable error — so a guessed
token can't be told apart from "trip doesn't exist" or "token well-formed
but wrong".
"""
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session

from ..auth import verify_ical_token
from ..database import get_session
from ..ical_export import build_trip_ics
from ..models import Trip

router = APIRouter()


@router.get("/calendar/{token}.ics")
def calendar_feed(token: str, session: Session = Depends(get_session)):
    trip_id = verify_ical_token(token)
    if trip_id is None:
        raise HTTPException(status_code=404, detail="Not found")

    trip = session.get(Trip, trip_id)
    if not trip:
        raise HTTPException(status_code=404, detail="Not found")

    ics = build_trip_ics(session, trip_id, trip.name)
    return Response(content=ics, media_type="text/calendar; charset=utf-8")
