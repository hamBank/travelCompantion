"""Serves the SPA shell for a copied trip/stop/item deep link.

GET /t/{...} -> serves the compiled SPA (index.html), for any path shape
frontend/src/urlPath.js defines (/t/:tripId, /t/:tripId/day/:day,
/t/:tripId/item/:itemId, /t/:tripId/stop/:stopId). The React app inspects
location.pathname client-side (App.jsx's deep-link boot effect) and opens
the right trip/day/item/stop once it and the user's own session have
loaded — this route's only job is making sure a browser hitting the link
directly (no service worker installed yet to serve its own navigation
fallback — see vite.config.js's workbox.navigateFallback) gets the app
shell instead of a 404. Same pattern as GET /shared/{token} in
routers/shared.py, but this path is for the *authenticated* app (a link to
one's own trip, not the public read-only share view) — added to
_PUBLIC_PREFIXES in main.py for the same reason /shared/ is: this route
itself carries no data, only the shell, so it doesn't need the Bearer
token the app's own subsequent API calls will require and enforce as
normal.

Deliberately does not validate the path at all (trip id, kind, value) —
an invalid/deleted/inaccessible target just falls through to the trip list
client-side, same as a stale share link does.
"""
import os
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter()

_STATIC_INDEX = os.path.join(os.path.dirname(__file__), "..", "static", "index.html")


@router.get("/t/{_path:path}")
def deep_link_page(_path: str):
    if os.path.isfile(_STATIC_INDEX):
        return FileResponse(_STATIC_INDEX, media_type="text/html")
    raise HTTPException(status_code=404, detail="Not found")
