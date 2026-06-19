from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlmodel import Session, select
from sqlalchemy import nullslast
from typing import List
import os, io, math, xml.etree.ElementTree as ET, httpx
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

_AVIATIONSTACK_KEY = os.getenv("AVIATIONSTACK_KEY", "")
_AERODATABOX_KEY   = os.getenv("AERODATABOX_KEY", "")

@router.get("/items/{item_id}/flight-check")
def check_flight(item_id: int, session: Session = Depends(get_session)):
    if not _AERODATABOX_KEY:
        raise HTTPException(status_code=503, detail="Flight check not configured (set AERODATABOX_KEY)")
    item = session.get(ItineraryItem, item_id)
    if not item or item.kind != "flight":
        raise HTTPException(status_code=404, detail="Flight item not found")

    d = item.details or {}
    flight_iata = d.get("flight_number", "").replace(" ", "").upper()
    if not flight_iata:
        raise HTTPException(status_code=400, detail="No flight number stored")

    dep_date = (d.get("depart_time") or "")[:10]
    if not dep_date:
        raise HTTPException(status_code=400, detail="No departure date stored")

    try:
        with httpx.Client(timeout=12) as client:
            r = client.get(
                f"https://aerodatabox.p.rapidapi.com/flights/number/{flight_iata}/{dep_date}",
                headers={
                    "X-RapidAPI-Key":  _AERODATABOX_KEY,
                    "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
                },
            )
        body = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Flight API unreachable: {e}")

    if not r.is_success:
        msg = body.get("message") or body.get("detail") or f"API returned {r.status_code}"
        raise HTTPException(status_code=502, detail=msg)

    flights = body if isinstance(body, list) else body.get("data", [])
    if not flights:
        return {"found": False, "flight_iata": flight_iata, "checks": []}

    live = flights[0]
    dep  = live.get("departure", {})
    arr  = live.get("arrival", {})
    al   = live.get("airline", {})

    def hhmm_stored(iso):
        try: return iso[11:16] if iso else None
        except: return None

    def hhmm_live(local_str):
        # AeroDataBox local time: "2025-07-15 11:45+08:00"
        try: return local_str[11:16] if local_str else None
        except: return None

    def local_to_iso(local_str):
        # "2025-07-15 11:45+08:00" → "2025-07-15T11:45"
        try: return local_str[:16].replace(" ", "T") if local_str else None
        except: return None

    def chk(label, key, stored, live_val, update_val=None):
        if live_val is None:
            return None
        stored_s = (stored or "").strip()
        live_s   = live_val.strip()
        match = stored_s.upper() == live_s.upper() if stored_s else None
        return {
            "field": label, "key": key,
            "stored": stored_s or None, "live": live_s,
            "update_value": (update_val or live_val).strip(),
            "match": match,
        }

    dep_local = dep.get("scheduledTime", {}).get("local")
    arr_local = arr.get("scheduledTime", {}).get("local")

    results = [c for c in [
        chk("Origin",       "origin",          d.get("origin"),          dep.get("airport", {}).get("iata")),
        chk("Destination",  "destination",     d.get("destination"),     arr.get("airport", {}).get("iata")),
        chk("Airline",      "airline",         d.get("airline"),         al.get("name")),
        chk("Depart time",  "depart_time",     hhmm_stored(d.get("depart_time")), hhmm_live(dep_local), local_to_iso(dep_local)),
        chk("Arrive time",  "arrive_time",     hhmm_stored(d.get("arrive_time")), hhmm_live(arr_local), local_to_iso(arr_local)),
        chk("Dep terminal", "origin_terminal", d.get("origin_terminal"), dep.get("terminal")),
        chk("Dep gate",     "origin_gate",     d.get("origin_gate"),     dep.get("gate")),
        chk("Check-in",     "checkin_desk",    d.get("checkin_desk"),    dep.get("checkInDesk")),
        chk("Arr terminal", "arrive_terminal", d.get("arrive_terminal"), arr.get("terminal")),
        chk("Arr gate",     "arrive_gate",     d.get("arrive_gate"),     arr.get("gate")),
    ] if c]

    return {
        "found": True,
        "flight_iata": flight_iata,
        "flight_status": live.get("status"),
        "checks": results,
    }

@router.get("/flights/airline-lookup")
def airline_lookup(iata: str):
    if not _AERODATABOX_KEY:
        raise HTTPException(status_code=503, detail="Flight check not configured (set AERODATABOX_KEY)")
    code = iata.strip().upper()[:2]
    if len(code) < 2:
        raise HTTPException(status_code=400, detail="Provide a 2-letter airline IATA code")
    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(
                f"https://aerodatabox.p.rapidapi.com/airlines/{code}",
                headers={
                    "X-RapidAPI-Key":  _AERODATABOX_KEY,
                    "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
                },
            )
        body = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Airline API unreachable: {e}")
    if not r.is_success:
        detail = (body.get("message") if isinstance(body, dict) else None) or f"Airline {code} not found"
        raise HTTPException(status_code=404 if r.status_code == 404 else 502, detail=detail)
    name = (body.get("name") or body.get("shortName") or body.get("fullName")) if isinstance(body, dict) else None
    if not name:
        raise HTTPException(status_code=404, detail=f"Airline {code} not found")
    return {"iata": code, "name": name}


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


# ── Elevation enrichment ───────────────────────────────────────────────────────

_TOPO_API = "https://api.opentopodata.org/v1/srtm90m"
_TOPO_MAX = 100  # API limit per request

def _has_elevation(content: bytes) -> bool:
    try:
        root = ET.fromstring(content)
        ns = root.tag.split('}')[0].lstrip('{') if '}' in root.tag else ''
        pfx = f'{{{ns}}}' if ns else ''
        for pt in root.findall(f'.//{pfx}trkpt'):
            el = pt.find(f'{pfx}ele')
            if el is not None and el.text and el.text.strip():
                return True
    except Exception:
        pass
    return False

def _add_elevation_to_gpx(content: bytes) -> bytes:
    """Fetch SRTM elevation for track points and inject <ele> tags."""
    try:
        # Register all namespaces so re-serialisation preserves prefixes
        for _, (ns_prefix, uri) in ET.iterparse(io.BytesIO(content), events=['start-ns']):
            ET.register_namespace(ns_prefix, uri)

        root = ET.fromstring(content)
        ns = root.tag.split('}')[0].lstrip('{') if '}' in root.tag else ''
        pfx = f'{{{ns}}}' if ns else ''
        pts = root.findall(f'.//{pfx}trkpt')
        if len(pts) < 2:
            return content

        n = len(pts)
        stride = max(1, n // (_TOPO_MAX - 1))
        sample_idxs = list(range(0, n, stride))[: _TOPO_MAX - 1]
        if sample_idxs[-1] != n - 1:
            sample_idxs.append(n - 1)

        locs = "|".join(f"{pts[i].get('lat')},{pts[i].get('lon')}" for i in sample_idxs)

        with httpx.Client(timeout=25) as client:
            resp = client.post(_TOPO_API, json={"locations": locs})
            resp.raise_for_status()
            results = resp.json().get("results", [])

        raw_eles = [r.get("elevation") for r in results]
        ele_at = {sample_idxs[j]: raw_eles[j]
                  for j in range(min(len(raw_eles), len(sample_idxs)))
                  if raw_eles[j] is not None}
        if not ele_at:
            return content

        keys = sorted(ele_at.keys())
        all_eles = [None] * n

        # fill before first sample
        for i in range(keys[0]):
            all_eles[i] = ele_at[keys[0]]

        # interpolate between samples
        for ki in range(len(keys) - 1):
            i0, i1 = keys[ki], keys[ki + 1]
            e0, e1 = ele_at[i0], ele_at[i1]
            span = i1 - i0
            for i in range(i0, i1 + 1):
                all_eles[i] = round(e0 + (e1 - e0) * (i - i0) / span, 1)

        # inject <ele> into each trkpt
        for i, pt in enumerate(pts):
            if all_eles[i] is None:
                continue
            ele_el = pt.find(f'{pfx}ele')
            if ele_el is None:
                ele_el = ET.SubElement(pt, f'{pfx}ele')
            ele_el.text = str(all_eles[i])

        xml_body = ET.tostring(root, encoding='unicode')
        return b'<?xml version="1.0" encoding="UTF-8"?>\n' + xml_body.encode('utf-8')

    except Exception:
        return content  # non-fatal: return original if anything fails


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
    if not _has_elevation(content):
        content = _add_elevation_to_gpx(content)
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
