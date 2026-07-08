"""Public, revocable read-only trip share link.

Two distinct routes, deliberately split so a browser hitting the link
directly still gets the SPA, while the frontend's own fetch gets JSON:

  - GET /shared/{token}          -> serves the compiled SPA (index.html).
    The React app inspects location.pathname client-side (see App.jsx) and
    renders a read-only SharedTripView, which then calls the JSON route
    below. This route ALWAYS returns the SPA shell, valid token or not —
    the SPA itself shows an error state on a 404 from the JSON route, so
    there's no need (and no user-facing difference) to 404 the HTML here.
  - GET /shared/{token}/timeline -> the actual JSON payload, same shape as
    the authenticated GET /trips/{id}/timeline (built by the shared
    build_trip_timeline() helper in routers/trips.py — no duplicated
    serialization). Unknown/revoked token -> a plain 404.

Both are added to _PUBLIC_PREFIXES in backend/main.py (via "/shared/") since
access control here is entirely the token itself, like the tokenized iCal
feed in routers/calendar.py — no Bearer JWT is presented or checked.

Security note: this endpoint must NEVER expose anything beyond what the
normal (authenticated) timeline payload already contains. In particular it
must not, and does not, touch any billed external-API proxy (day-map,
river-map, gpx-map in routers/items.py) — those stay behind
require_stop_role/require_item_role and are unreachable without a Bearer
token, share link or not.
"""
import os
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from ..database import get_session
from ..models import Trip, TripRole
from .trips import build_trip_timeline, TripTimeline

router = APIRouter()

_STATIC_INDEX = os.path.join(os.path.dirname(__file__), "..", "static", "index.html")


def _trip_for_token(session: Session, token: str) -> Trip:
    trip = session.exec(select(Trip).where(Trip.share_token == token)).first()
    if not trip:
        # Same plain 404 for "no such token" and "token well-formed but
        # revoked" — don't let a guess distinguish the two.
        raise HTTPException(status_code=404, detail="Not found")
    return trip


@router.get("/shared/{token}/timeline", response_model=TripTimeline)
def shared_trip_timeline(token: str, session: Session = Depends(get_session)):
    trip = _trip_for_token(session, token)
    return build_trip_timeline(session, trip.id, TripRole.viewer)


@router.get("/shared/{token}")
def shared_trip_page(token: str):
    """Serve the SPA shell for the browser-facing share URL. Deliberately
    does NOT validate the token — see module docstring — the SPA validates
    it via the /timeline route above once loaded."""
    if os.path.isfile(_STATIC_INDEX):
        return FileResponse(_STATIC_INDEX, media_type="text/html")
    raise HTTPException(status_code=404, detail="Not found")
