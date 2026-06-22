from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlmodel import Session, select
from sqlalchemy import nullslast
from sqlalchemy.orm.attributes import flag_modified
from typing import List
import os, io, math, time, xml.etree.ElementTree as ET, httpx
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
        if field == 'details':
            flag_modified(item, 'details')
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, session: Session = Depends(get_session)):
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    # For accommodation items, clear the legacy stop.accommodation field so the
    # startup backfill and timeline lazy-migration don't recreate the item.
    if item.kind == "accommodation":
        stop = session.get(Stop, item.stop_id)
        if stop and stop.accommodation:
            stop.accommodation = ""
            stop.accommodation_link = ""
            stop.accommodation_notes = ""
            session.add(stop)
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

_AIRLINE_NAMES: dict[str, str] = {
    "QF": "Qantas", "EK": "Emirates", "SQ": "Singapore Airlines", "CX": "Cathay Pacific",
    "AY": "Finnair", "BA": "British Airways", "LH": "Lufthansa", "AF": "Air France",
    "KL": "KLM", "AA": "American Airlines", "UA": "United Airlines", "DL": "Delta Air Lines",
    "WN": "Southwest Airlines", "AS": "Alaska Airlines", "B6": "JetBlue Airways",
    "NK": "Spirit Airlines", "F9": "Frontier Airlines", "G4": "Allegiant Air",
    "HA": "Hawaiian Airlines", "VS": "Virgin Atlantic", "AC": "Air Canada",
    "WS": "WestJet", "JL": "Japan Airlines", "NH": "All Nippon Airways",
    "KE": "Korean Air", "OZ": "Asiana Airlines", "TG": "Thai Airways",
    "MH": "Malaysia Airlines", "GA": "Garuda Indonesia", "PR": "Philippine Airlines",
    "VN": "Vietnam Airlines", "CI": "China Airlines", "BR": "EVA Air",
    "MU": "China Eastern", "CA": "Air China", "CZ": "China Southern",
    "HU": "Hainan Airlines", "ZH": "Shenzhen Airlines", "AI": "Air India",
    "6E": "IndiGo", "SG": "SpiceJet", "EY": "Etihad Airways", "GF": "Gulf Air",
    "WY": "Oman Air", "FZ": "flydubai", "G9": "Air Arabia", "XY": "flynas",
    "MS": "EgyptAir", "ET": "Ethiopian Airlines", "KQ": "Kenya Airways",
    "SA": "South African Airways", "FR": "Ryanair", "U2": "easyJet",
    "VY": "Vueling", "IB": "Iberia", "AZ": "ITA Airways", "TP": "TAP Air Portugal",
    "LX": "Swiss International Air Lines", "OS": "Austrian Airlines",
    "SK": "SAS Scandinavian Airlines", "FI": "Icelandair", "TK": "Turkish Airlines",
    "PC": "Pegasus Airlines", "LO": "LOT Polish Airlines", "OK": "Czech Airlines",
    "RO": "TAROM", "BT": "airBaltic", "NZ": "Air New Zealand", "JQ": "Jetstar",
    "VA": "Virgin Australia", "TR": "Scoot", "AK": "AirAsia", "FD": "Thai AirAsia",
    "QZ": "AirAsia Indonesia", "D7": "AirAsia X", "3K": "Jetstar Asia",
    "7C": "Jeju Air", "BX": "Air Busan", "TW": "T'way Air", "ZE": "Eastar Jet",
    "OO": "SkyWest Airlines", "YX": "Republic Airways", "9E": "Endeavor Air",
    "MQ": "Envoy Air", "OH": "PSA Airlines", "PT": "Piedmont Airlines",
    "EV": "ExpressJet", "WX": "CityJet", "BE": "Flybe", "LS": "Jet2",
    "EZY": "easyJet", "WZ": "Red Wings", "5O": "ASL Airlines France",
    "A3": "Aegean Airlines", "OA": "Olympic Air", "HV": "Transavia",
    "TO": "Transavia France", "VT": "Air Tahiti", "UU": "Air Austral",
    "MF": "Xiamen Airlines", "SC": "Shandong Airlines", "KN": "China United Airlines",
    "GS": "Tianjin Airlines", "NS": "Hebei Airlines", "EU": "Chengdu Airlines",
    "PN": "West Air", "UQ": "Urumqi Air", "8L": "Lucky Air",
    "Y8": "Loong Air", "GJ": "Zhejiang Loong Airlines", "RU": "AirBridgeCargo",
    "SU": "Aeroflot", "S7": "S7 Airlines", "UT": "UTair", "UN": "Transaero",
    "FV": "Rossiya", "DP": "Pobeda", "N4": "Nordwind Airlines",
    "4G": "Gazpromavia", "KC": "Air Astana", "HY": "Uzbekistan Airways",
    "T5": "Turkmenistan Airlines", "PS": "Ukraine International Airlines",
    "6H": "Israir", "LY": "El Al", "IZ": "Arkia", "GO": "Kuwaiti Airlines",
    "KU": "Kuwait Airways", "RJ": "Royal Jordanian", "ME": "Middle East Airlines",
    "QR": "Qatar Airways", "SV": "Saudi Arabian Airlines", "YY": "Flynas",
    "XW": "NokScoot", "DD": "Nok Air", "PG": "Bangkok Airways",
    "QV": "Lao Airlines", "VJ": "VietJet Air", "BL": "Pacific Airlines",
    "5J": "Cebu Pacific", "DG": "Cebgo", "Z2": "Philippines AirAsia",
    "MJ": "Mihin Lanka", "UL": "SriLankan Airlines", "4O": "Air Flamenco",
    "LQ": "Lanmei Airlines", "K6": "Cambodia Angkor Air",
    "BI": "Royal Brunei Airlines", "MI": "SilkAir", "IN": "Nam Air",
    "ID": "Batik Air", "IW": "Wings Air", "JT": "Lion Air",
    "XT": "Indonesia AirAsia", "SJ": "Sriwijaya Air", "XN": "Xpressair",
    "AE": "Mandarin Airlines", "IT": "Tigerair Taiwan", "GE": "TransAsia Airways",
    "DA": "Air Georgian", "4M": "LATAM Argentina", "LA": "LATAM Airlines",
    "JJ": "LATAM Brasil", "LP": "LATAM Peru", "XL": "LATAM Ecuador",
    "LU": "LATAM Express", "PZ": "LATAM Paraguay", "AV": "Avianca",
    "O6": "Avianca Brasil", "5Z": "Cem Air", "AM": "Aeromexico",
    "MX": "Mexicana", "Y4": "Volaris", "4A": "VIVA Aerobus",
    "2I": "Star Peru", "8R": "TACA Regional", "CM": "Copa Airlines",
    "HP": "Spirit Panama", "WC": "Islena Airlines",
    "WP": "Island Air", "ZL": "Regional Express", "TL": "Airnorth",
    "FO": "Felix Airways", "EI": "Aer Lingus", "FR1": "Ryanair",
    "HW": "North Wright Air", "PD": "Porter Airlines", "TS": "Air Transat",
    "WG": "Sunwing Airlines", "F8": "Flair Airlines",
}

@router.get("/flights/airline-lookup")
def airline_lookup(iata: str):
    code = iata.strip().upper()
    # Accept 2-char codes; also strip leading digit-letter combos
    code = code[:2]
    if len(code) < 2:
        raise HTTPException(status_code=400, detail="Provide a 2-letter airline IATA code")
    name = _AIRLINE_NAMES.get(code)
    if not name:
        raise HTTPException(status_code=404, detail=f"Airline {code} not found in lookup table")
    return {"iata": code, "name": name}


_DB_REST_HOSTS = ["https://v6.db.transport.rest", "https://v5.db.transport.rest"]
_DB_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

@router.get("/items/{item_id}/rail-check")
def check_rail(item_id: int, session: Session = Depends(get_session)):
    item = session.get(ItineraryItem, item_id)
    if not item or item.kind != "rail":
        raise HTTPException(status_code=404, detail="Rail item not found")

    d = item.details or {}
    train_number = d.get("train_number", "").strip()
    if not train_number:
        raise HTTPException(status_code=400, detail="No train number stored")

    origin_name = d.get("origin", "").strip()
    if not origin_name:
        raise HTTPException(status_code=400, detail="No origin station stored — add it in the edit form first")

    def hhmm(iso):
        try: return iso[11:16] if iso else None
        except Exception: return None

    def iso_trim(iso):
        try: return iso[:16] if iso else None
        except Exception: return None

    def chk(label, key, stored, live_val, update_val=None):
        if live_val is None:
            return None
        stored_s = (stored or "").strip()
        live_s   = str(live_val).strip()
        match = stored_s.lower() == live_s.lower() if stored_s else None
        upd = update_val or live_val
        return {
            "field": label, "key": key,
            "stored": stored_s or None, "live": live_s,
            "update_value": upd.strip() if isinstance(upd, str) else str(upd),
            "match": match,
        }

    dep_time = d.get("depart_time", "")
    dep_params: dict = {"results": 30, "duration": 20, "language": "en", "stopovers": "false"}
    if dep_time:
        dep_params["when"] = dep_time

    locations  = None
    dep_body   = None
    last_error = "Rail API unreachable"

    # Try each host in order; skip to next on 503/network error
    with httpx.Client(timeout=14, headers=_DB_HEADERS) as client:
        for host in _DB_REST_HOSTS:
            try:
                loc_r = client.get(f"{host}/locations", params={
                    "query": origin_name, "results": 3, "stops": "true", "language": "en",
                })
                if loc_r.status_code == 503:
                    last_error = f"DB REST API unavailable ({host})"
                    continue
                if not loc_r.is_success or not loc_r.text:
                    last_error = f"Station lookup failed ({loc_r.status_code})"
                    continue
                locations = loc_r.json()
                if not locations:
                    return {"found": False, "train_number": train_number, "checks": []}

                stop_id   = locations[0]["id"]

                dep_r = client.get(f"{host}/stops/{stop_id}/departures", params=dep_params)
                if not dep_r.is_success or not dep_r.text:
                    last_error = f"Departures failed ({dep_r.status_code})"
                    locations = None
                    continue

                dep_body = dep_r.json()
                break  # success — exit host loop

            except Exception as e:
                last_error = str(e)
                locations = None
                continue

    if locations is None or dep_body is None:
        raise HTTPException(status_code=502, detail=last_error)

    stop_name  = locations[0].get("name", origin_name)
    departures = dep_body.get("departures", dep_body) if isinstance(dep_body, dict) else dep_body
    if not isinstance(departures, list):
        departures = []

    # Match departure by train number (flexible: "ICE123" == "ICE 123")
    train_key   = train_number.replace(" ", "").upper()
    matched_dep = None
    for dep in departures:
        line_name = (dep.get("line") or {}).get("name") or ""
        if line_name.replace(" ", "").upper() == train_key:
            matched_dep = dep
            break

    if not matched_dep:
        return {"found": False, "train_number": train_number, "checks": []}

    line         = matched_dep.get("line") or {}
    dep_planned  = matched_dep.get("plannedWhen")
    dep_platform = matched_dep.get("plannedPlatform") or matched_dep.get("platform")
    operator_nm  = (line.get("operator") or {}).get("name")
    trip_id      = matched_dep.get("tripId")

    # Fetch trip stopovers to get arrival info at destination
    arr_planned  = None
    arr_platform = None
    dest_name    = None

    if trip_id:
        # Use the first host that responded successfully
        working_host = next(
            (h for h in _DB_REST_HOSTS if locations[0].get("id")),
            _DB_REST_HOSTS[0],
        )
        try:
            with httpx.Client(timeout=14, headers=_DB_HEADERS) as client:
                trip_r = client.get(f"{working_host}/trips/{trip_id}", params={
                    "stopovers": "true", "language": "en",
                })
            if trip_r.is_success and trip_r.text:
                trip_data   = trip_r.json().get("trip", {})
                stopovers   = trip_data.get("stopovers", [])
                dest_stored = (d.get("destination") or "").strip().upper()
                for sv in stopovers:
                    sv_name = (sv.get("stop") or {}).get("name") or ""
                    if dest_stored and dest_stored in sv_name.upper():
                        arr_planned  = sv.get("plannedArrival")
                        arr_platform = sv.get("plannedArrivalPlatform") or sv.get("arrivalPlatform")
                        dest_name    = sv_name
                        break
                if not arr_planned and stopovers:
                    last         = stopovers[-1]
                    arr_planned  = last.get("plannedArrival")
                    arr_platform = last.get("plannedArrivalPlatform") or last.get("arrivalPlatform")
                    dest_name    = (last.get("stop") or {}).get("name")
        except Exception:
            pass

    results = [c for c in [
        chk("Origin",       "origin",          d.get("origin"),          stop_name),
        chk("Destination",  "destination",     d.get("destination"),     dest_name),
        chk("Operator",     "operator",        d.get("operator"),        operator_nm),
        chk("Depart time",  "depart_time",     hhmm(d.get("depart_time")), hhmm(dep_planned), iso_trim(dep_planned)),
        chk("Arrive time",  "arrive_time",     hhmm(d.get("arrive_time")), hhmm(arr_planned), iso_trim(arr_planned)),
        chk("Dep platform", "depart_platform", d.get("depart_platform"), dep_platform),
        chk("Arr platform", "arrive_platform", d.get("arrive_platform"), arr_platform),
    ] if c]

    return {
        "found": True,
        "train_number": line.get("name") or train_number,
        "checks": results,
    }


_NOMINATIM = "https://nominatim.openstreetmap.org/search"
_NOMINATIM_HEADERS = {"User-Agent": "TravelCompanion/1.0 (personal travel planner)"}

@router.get("/geocode")
def geocode(q: str):
    """Resolve a place name to coordinates via Nominatim (OSM, free, no key)."""
    try:
        with httpx.Client(timeout=8, headers=_NOMINATIM_HEADERS) as client:
            r = client.get(_NOMINATIM, params={"q": q, "format": "json", "limit": 1})
            results = r.json()
        if results:
            return {"lat": float(results[0]["lat"]), "lng": float(results[0]["lon"]), "display": results[0].get("display_name", q)}
    except Exception:
        pass
    raise HTTPException(status_code=404, detail=f"Could not geocode: {q}")


@router.get("/route-elevation")
def route_elevation(lat1: float, lng1: float, lat2: float, lng2: float):
    """Return SRTM elevations at two coordinates using OpenTopoData (free, no key)."""
    locations = f"{lat1},{lng1}|{lat2},{lng2}"
    try:
        with httpx.Client(timeout=10) as client:
            r = client.post(_TOPO_API, json={"locations": locations})
            r.raise_for_status()
            results = r.json().get("results", [])
        if len(results) >= 2 and all(res.get("elevation") is not None for res in results[:2]):
            return {
                "start_elevation": results[0]["elevation"],
                "end_elevation":   results[1]["elevation"],
            }
    except Exception:
        pass
    raise HTTPException(status_code=503, detail="Elevation lookup unavailable")


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
