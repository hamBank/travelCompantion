from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlmodel import Session, select
from sqlalchemy import nullslast
from typing import List
import os, math, xml.etree.ElementTree as ET, httpx
from ..database import get_session
from ..models import ItineraryItem, ItemCreate, ItemRead, ItemUpdate, Stop

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_GPX_DIR  = os.path.join(_APP_ROOT, 'uploads', 'gpx')

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
    if not item or item.kind not in ("accommodation", "restaurant", "activity"):
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


# ── GPX helpers ────────────────────────────────────────────────────────────────

def _haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return R * 2 * math.asin(math.sqrt(a))

def _extract_gpx_stats(content: bytes) -> dict:
    try:
        root = ET.fromstring(content)
        ns = root.tag.split('}')[0].lstrip('{') if '}' in root.tag else ''
        prefix = f'{{{ns}}}' if ns else ''
        pts = root.findall(f'.//{prefix}trkpt')
        coords = []
        for pt in pts:
            lat = float(pt.get('lat', 0))
            lon = float(pt.get('lon', 0))
            ele_el = pt.find(f'{prefix}ele')
            ele = float(ele_el.text) if ele_el is not None and ele_el.text else None
            coords.append((lat, lon, ele))
        if len(coords) < 2:
            return {}
        dist = sum(_haversine(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
                   for i in range(len(coords)-1))
        gain = loss = 0.0
        for i in range(1, len(coords)):
            if coords[i][2] is not None and coords[i-1][2] is not None:
                d = coords[i][2] - coords[i-1][2]
                if d > 0: gain += d
                else: loss += abs(d)
        stats = {'gpx_distance_m': round(dist), 'gpx_gain_m': round(gain), 'gpx_loss_m': round(loss)}
        if dist >= 1000:
            stats['distance'] = f"{dist/1000:.1f} km"
        else:
            stats['distance'] = f"{round(dist)} m"
        if gain:
            stats['elevation_gain'] = f"{round(gain)} m"
        if loss:
            stats['elevation_loss'] = f"{round(loss)} m"
        return stats
    except Exception:
        return {}


# ── GPX upload / download ──────────────────────────────────────────────────────

@router.post("/items/{item_id}/gpx", response_model=ItemRead)
async def upload_gpx(item_id: int, file: UploadFile = File(...), session: Session = Depends(get_session)):
    item = session.get(ItineraryItem, item_id)
    if not item or item.kind != "cycling":
        raise HTTPException(status_code=404, detail="Cycling item not found")
    content = await file.read()
    os.makedirs(_GPX_DIR, exist_ok=True)
    with open(os.path.join(_GPX_DIR, f"{item_id}.gpx"), 'wb') as f:
        f.write(content)
    details = dict(item.details or {})
    details['gpx_filename'] = f"{item_id}.gpx"
    details['original_gpx_name'] = file.filename or 'route.gpx'
    stats = _extract_gpx_stats(content)
    for key in ('distance', 'elevation_gain', 'elevation_loss'):
        if stats.get(key) and not details.get(key):
            details[key] = stats[key]
    details['gpx_distance_m'] = stats.get('gpx_distance_m')
    details['gpx_gain_m']     = stats.get('gpx_gain_m')
    details['gpx_loss_m']     = stats.get('gpx_loss_m')
    item.details = details
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.get("/items/{item_id}/gpx")
def download_gpx(item_id: int, session: Session = Depends(get_session)):
    item = session.get(ItineraryItem, item_id)
    if not item or item.kind != "cycling":
        raise HTTPException(status_code=404, detail="Cycling item not found")
    details = item.details or {}
    fp = os.path.join(_GPX_DIR, f"{item_id}.gpx")
    if not os.path.exists(fp):
        raise HTTPException(status_code=404, detail="No GPX file uploaded")
    return FileResponse(fp, media_type='application/gpx+xml',
                        filename=details.get('original_gpx_name', 'route.gpx'))
