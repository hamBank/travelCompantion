from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Response
from fastapi.responses import FileResponse
from sqlmodel import Session, select
from sqlalchemy import nullslast, func
from sqlalchemy.orm.attributes import flag_modified
from typing import List, Optional
import os, io, math, time, re, json, hashlib, urllib.request, urllib.error, urllib.parse, xml.etree.ElementTree as ET, httpx
from pydantic import BaseModel
from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_stop_role, require_item_role
from ..models import ItineraryItem, ItemCreate, ItemRead, ItemUpdate, ItemHistory, ItemHistoryRead, ItemKind, Stop, StopRead, TripRole
from ..river_path import estimate_river_path, NoPlausiblePath
from ..metrics import record_external_call

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_GPX_DIR  = os.path.join(_APP_ROOT, 'uploads', 'gpx')

router = APIRouter()


# ── History helpers ────────────────────────────────────────────────────────────

def _item_snapshot(item) -> dict:
    return {
        "kind": item.kind,
        "name": item.name,
        "scheduled_at": item.scheduled_at.isoformat() if item.scheduled_at else None,
        "link": item.link,
        "cost": item.cost,
        "notes": item.notes,
        "status": item.status,
        "details": item.details,
    }


def record_item_history(session, item, op: str, changed_by: str,
                        before=None, source: str = ""):
    snap = _item_snapshot(item)
    diff = {"before": before, "after": snap} if before is not None else None
    session.add(ItemHistory(
        item_id=item.id, op=op, changed_by=changed_by,
        snapshot=snap, diff=diff, source=source,
    ))


# ── CRUD ──────────────────────────────────────────────────────────────────────

@router.get("/stops/{stop_id}/items", response_model=List[ItemRead])
def list_items(stop_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_stop_role(session, user, stop_id, TripRole.viewer)
    return session.exec(
        select(ItineraryItem)
        .where(ItineraryItem.stop_id == stop_id)
        .order_by(nullslast(ItineraryItem.scheduled_at))
    ).all()


@router.post("/stops/{stop_id}/items", response_model=ItemRead, status_code=201)
def create_item(stop_id: int, item_in: ItemCreate, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_stop_role(session, user, stop_id, TripRole.editor)
    item = ItineraryItem(**item_in.model_dump(), stop_id=stop_id)
    session.add(item)
    session.commit()
    session.refresh(item)
    record_item_history(session, item, "create", user["email"])
    session.commit()
    return item


@router.get("/items/{item_id}", response_model=ItemRead)
def get_item(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_item_role(session, user, item_id, TripRole.viewer)
    return session.get(ItineraryItem, item_id)


@router.patch("/items/{item_id}", response_model=ItemRead)
def update_item(item_id: int, item_in: ItemUpdate, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_item_role(session, user, item_id, TripRole.editor)
    item = session.get(ItineraryItem, item_id)
    before = _item_snapshot(item)
    for field, value in item_in.model_dump(exclude_unset=True).items():
        setattr(item, field, value)
        if field == 'details':
            flag_modified(item, 'details')
    session.add(item)
    session.commit()
    session.refresh(item)
    record_item_history(session, item, "update", user["email"], before=before)
    session.commit()
    return item


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_item_role(session, user, item_id, TripRole.editor)
    item = session.get(ItineraryItem, item_id)
    before = _item_snapshot(item)
    # For accommodation items, clear the legacy stop.accommodation field so the
    # startup backfill and timeline lazy-migration don't recreate the item.
    if item.kind == "accommodation":
        stop = session.get(Stop, item.stop_id)
        if stop and stop.accommodation:
            stop.accommodation = ""
            stop.accommodation_link = ""
            stop.accommodation_notes = ""
            session.add(stop)
    record_item_history(session, item, "delete", user["email"], before=before)
    session.delete(item)
    session.commit()


@router.get("/items/{item_id}/history", response_model=List[ItemHistoryRead])
def item_history(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Change history for an item — newest entries first."""
    require_item_role(session, user, item_id, TripRole.viewer)
    return session.exec(
        select(ItemHistory)
        .where(ItemHistory.item_id == item_id)
        .order_by(ItemHistory.changed_at.desc())
    ).all()


@router.get("/items/{item_id}/sibling-stops", response_model=List[StopRead])
def sibling_stops(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Stops in the same trip as this item — for the 'move to stop' picker."""
    require_item_role(session, user, item_id, TripRole.viewer)
    item = session.get(ItineraryItem, item_id)
    stop = session.get(Stop, item.stop_id)
    return session.exec(
        select(Stop).where(Stop.trip_id == stop.trip_id).order_by(nullslast(func.date(Stop.arrive)), nullslast(func.date(Stop.depart)), Stop.sort_order)
    ).all()


class MoveItemRequest(BaseModel):
    stop_id: int


@router.post("/items/{item_id}/move", response_model=ItemRead)
def move_item(item_id: int, req: MoveItemRequest, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Move an item to another stop in the same trip. Requires editor on both ends."""
    require_item_role(session, user, item_id, TripRole.editor)
    require_stop_role(session, user, req.stop_id, TripRole.editor)
    item = session.get(ItineraryItem, item_id)
    src = session.get(Stop, item.stop_id)
    dst = session.get(Stop, req.stop_id)
    if not dst or dst.trip_id != src.trip_id:
        raise HTTPException(status_code=400, detail="Target stop must be in the same trip")
    item.stop_id = req.stop_id
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


_PLACES_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")
# Routes API can use a dedicated key; falls back to the Places key if unset.
_ROUTES_KEY = os.getenv("GOOGLE_ROUTE_API_KEY", "") or _PLACES_KEY
_PLACES_BASE = "https://maps.googleapis.com/maps/api/place"

_AVIATIONSTACK_KEY = os.getenv("AVIATIONSTACK_KEY", "")
_AERODATABOX_KEY   = os.getenv("AERODATABOX_KEY", "")

@router.get("/items/{item_id}/flight-check")
def check_flight(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_item_role(session, user, item_id, TripRole.editor)
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
        record_external_call("aerodatabox", ok=False, error=str(e))
        raise HTTPException(status_code=502, detail=f"Flight API unreachable: {e}")

    if not r.is_success:
        msg = body.get("message") or body.get("detail") or f"API returned {r.status_code}"
        record_external_call("aerodatabox", ok=False, error=msg)
        raise HTTPException(status_code=502, detail=msg)
    record_external_call("aerodatabox", ok=True)

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

    def tz_from_local(local_str):
        # "2025-07-15 11:45+08:00" → "GMT+8"  /  "... -05:00" → "GMT-5"
        import re
        if not local_str: return None
        m = re.search(r'([+-])(\d{2}):(\d{2})$', local_str)
        if not m: return None
        sign, h, mins = m.group(1), int(m.group(2)), int(m.group(3))
        return f"GMT{sign}{h}" if mins == 0 else f"GMT{sign}{h}:{m.group(3)}"

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

    # AeroDataBox reports the great-circle distance between the actual airport
    # coordinates — real-world flown distance, not a line we'd draw ourselves
    # between two guessed points. Prefer miles to match this app's other
    # flight-distance entry (placeholder "5,759 mi"); fall back to km.
    gcd = live.get("greatCircleDistance") or {}
    if gcd.get("mile") is not None:
        distance_live = f"{round(gcd['mile']):,} mi"
    elif gcd.get("km") is not None:
        distance_live = f"{round(gcd['km']):,} km"
    else:
        distance_live = None

    results = [c for c in [
        chk("Origin",       "origin",          d.get("origin"),          dep.get("airport", {}).get("iata")),
        chk("Destination",  "destination",     d.get("destination"),     arr.get("airport", {}).get("iata")),
        chk("Airline",      "airline",         d.get("airline"),         al.get("name")),
        chk("Depart time",  "depart_time",     hhmm_stored(d.get("depart_time")), hhmm_live(dep_local), local_to_iso(dep_local)),
        chk("Arrive time",  "arrive_time",     hhmm_stored(d.get("arrive_time")), hhmm_live(arr_local), local_to_iso(arr_local)),
        chk("Dep terminal", "origin_terminal", d.get("origin_terminal"), dep.get("terminal")),
        chk("Dep gate",     "origin_gate",     d.get("origin_gate"),     dep.get("gate")),
        chk("Check-in",     "checkin_desk",    d.get("checkin_desk"),    dep.get("checkInDesk")),
        chk("Dep timezone", "depart_tz",       d.get("depart_tz"),       tz_from_local(dep_local)),
        chk("Arr terminal", "arrive_terminal", d.get("arrive_terminal"), arr.get("terminal")),
        chk("Arr gate",     "arrive_gate",     d.get("arrive_gate"),     arr.get("gate")),
        chk("Arr timezone", "arrive_tz",       d.get("arrive_tz"),       tz_from_local(arr_local)),
        chk("Distance",     "distance",        d.get("distance"),        distance_live),
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
def check_rail(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_item_role(session, user, item_id, TripRole.editor)
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
                    record_external_call("db_transport_rest", ok=False, error=last_error)
                    continue
                if not loc_r.is_success or not loc_r.text:
                    last_error = f"Station lookup failed ({loc_r.status_code})"
                    record_external_call("db_transport_rest", ok=False, error=last_error)
                    continue
                record_external_call("db_transport_rest", ok=True)
                locations = loc_r.json()
                if not locations:
                    return {"found": False, "train_number": train_number, "checks": []}

                stop_id   = locations[0]["id"]

                dep_r = client.get(f"{host}/stops/{stop_id}/departures", params=dep_params)
                if not dep_r.is_success or not dep_r.text:
                    last_error = f"Departures failed ({dep_r.status_code})"
                    record_external_call("db_transport_rest", ok=False, error=last_error)
                    locations = None
                    continue
                record_external_call("db_transport_rest", ok=True)

                dep_body = dep_r.json()
                break  # success — exit host loop

            except Exception as e:
                last_error = str(e)
                record_external_call("db_transport_rest", ok=False, error=last_error)
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
                record_external_call("db_transport_rest", ok=True)
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
            else:
                record_external_call("db_transport_rest", ok=False, error=f"status {trip_r.status_code}")
        except Exception as e:
            record_external_call("db_transport_rest", ok=False, error=str(e))

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
        record_external_call("nominatim", ok=True)
        if results:
            return {"lat": float(results[0]["lat"]), "lng": float(results[0]["lon"]), "display": results[0].get("display_name", q)}
    except Exception as e:
        record_external_call("nominatim", ok=False, error=str(e))
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
        record_external_call("opentopodata", ok=True)
        if len(results) >= 2 and all(res.get("elevation") is not None for res in results[:2]):
            return {
                "start_elevation": results[0]["elevation"],
                "end_elevation":   results[1]["elevation"],
            }
    except Exception as e:
        record_external_call("opentopodata", ok=False, error=str(e))
    raise HTTPException(status_code=503, detail="Elevation lookup unavailable")


_ROUTES_API = "https://routes.googleapis.com/directions/v2:computeRoutes"
_COORD_RE = re.compile(r'^\s*-?\d+\.?\d*\s*,\s*-?\d+\.?\d*\s*$')
_TRAVEL_MODE = {"walk": "WALK", "cycling": "BICYCLE", "bike": "BICYCLE", "transfer": "DRIVE", "drive": "DRIVE"}


class RouteDistanceRequest(BaseModel):
    points: List[str]
    mode: str = "walk"


def _fmt_km(m):
    if m is None:
        return None
    return f"{m / 1000:.1f} km"


def _fmt_dur(secs):
    if not secs:
        return None
    h, m = divmod(round(secs / 60), 60)
    return f"{h}h {m}m" if h else f"{m}m"


def _decode_polyline(s):
    """Decode a Google encoded polyline string into a list of (lat, lng)."""
    coords, index, lat, lng = [], 0, 0, 0
    while index < len(s):
        for is_lat in (True, False):
            shift, result = 0, 0
            while True:
                b = ord(s[index]) - 63
                index += 1
                result |= (b & 0x1f) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if (result & 1) else (result >> 1)
            if is_lat:
                lat += d
            else:
                lng += d
        coords.append((lat / 1e5, lng / 1e5))
    return coords


def _encode_polyline(coords):
    """Encode a list of (lat, lng) into a Google encoded polyline string
    (inverse of _decode_polyline) — used to keep the river-map Static Maps
    request compact regardless of how many points the path has."""
    def _encode_value(v):
        v = ~(v << 1) if v < 0 else (v << 1)
        chunks = []
        while v >= 0x20:
            chunks.append((v & 0x1f) | 0x20)
            v >>= 5
        chunks.append(v)
        return ''.join(chr(c + 63) for c in chunks)

    out = []
    prev_lat = prev_lng = 0
    for lat, lng in coords:
        lat_i, lng_i = round(lat * 1e5), round(lng * 1e5)
        out.append(_encode_value(lat_i - prev_lat))
        out.append(_encode_value(lng_i - prev_lng))
        prev_lat, prev_lng = lat_i, lng_i
    return ''.join(out)


def _route_elevation_gain_loss(coords):
    """Sample a decoded route and compute total ascent/descent via OpenTopoData.
    Best-effort — returns (gain_m, loss_m) or (None, None) on any failure."""
    if len(coords) < 2:
        return None, None
    # OpenTopoData allows 100 locations/request — sample evenly.
    n, MAX = len(coords), 100
    stride = max(1, n // MAX)
    sample = coords[::stride]
    if sample[-1] != coords[-1]:
        sample.append(coords[-1])
    locations = "|".join(f"{lat},{lng}" for lat, lng in sample)
    try:
        with httpx.Client(timeout=12) as client:
            r = client.post(_TOPO_API, json={"locations": locations})
            r.raise_for_status()
            eles = [res.get("elevation") for res in r.json().get("results", [])]
        record_external_call("opentopodata", ok=True)
        eles = [e for e in eles if e is not None]
        if len(eles) < 2:
            return None, None
        gain = sum(max(0, eles[i] - eles[i - 1]) for i in range(1, len(eles)))
        loss = sum(max(0, eles[i - 1] - eles[i]) for i in range(1, len(eles)))
        return round(gain), round(loss)
    except Exception as e:
        record_external_call("opentopodata", ok=False, error=str(e))
        return None, None


def _fetch_route(points, mode):
    """Call the Google Routes API and return the first route dict (distanceMeters,
    duration, polyline.encodedPolyline). Raises HTTPException on any failure."""
    if not _ROUTES_KEY:
        raise HTTPException(status_code=503, detail="Routes API key not configured (set GOOGLE_ROUTE_API_KEY or GOOGLE_PLACES_API_KEY)")
    pts = [p.strip() for p in (points or []) if p and p.strip()]
    if len(pts) < 2:
        raise HTTPException(status_code=400, detail="Need at least a start and end point")

    def waypoint(s):
        if _COORD_RE.match(s):
            lat, lng = [float(x) for x in s.split(",")]
            return {"location": {"latLng": {"latitude": lat, "longitude": lng}}}
        return {"address": s}

    body = {
        "origin": waypoint(pts[0]),
        "destination": waypoint(pts[-1]),
        "travelMode": _TRAVEL_MODE.get(mode.lower(), "DRIVE"),
    }
    if len(pts) > 2:
        body["intermediates"] = [waypoint(p) for p in pts[1:-1]]

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": _ROUTES_KEY,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
    }
    request = urllib.request.Request(_ROUTES_API, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=15) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300] if e.fp else str(e)
        record_external_call("google_routes", ok=False, error=f"{e.code}: {detail}")
        raise HTTPException(status_code=502, detail=f"Routes API error {e.code}: {detail}")
    except Exception as e:
        record_external_call("google_routes", ok=False, error=str(e))
        raise HTTPException(status_code=502, detail=f"Routes API request failed: {e}")
    record_external_call("google_routes", ok=True)

    routes = data.get("routes") or []
    if not routes:
        raise HTTPException(status_code=404, detail="No route found for those points")
    return routes[0]


@router.post("/route-distance")
def route_distance(req: RouteDistanceRequest, user: dict = Depends(get_current_user)):
    """Real road/path-following distance + duration via the Google Routes API.

    Requires GOOGLE_PLACES_API_KEY with the Routes API enabled in the same project.
    """
    route = _fetch_route(req.points, req.mode)
    dist_m = route.get("distanceMeters")
    dur_raw = route.get("duration", "")
    secs = int(dur_raw[:-1]) if dur_raw.endswith("s") and dur_raw[:-1].isdigit() else None

    gain_m = loss_m = None
    encoded = (route.get("polyline") or {}).get("encodedPolyline")
    if encoded:
        try:
            gain_m, loss_m = _route_elevation_gain_loss(_decode_polyline(encoded))
        except Exception:
            pass

    return {
        "distance_m": dist_m,
        "duration_s": secs,
        "distance_text": _fmt_km(dist_m),
        "duration_text": _fmt_dur(secs),
        "elevation_gain_m": gain_m,
        "elevation_loss_m": loss_m,
        "elevation_gain_text": f"{gain_m} m" if gain_m is not None else None,
        "elevation_loss_text": f"{loss_m} m" if loss_m is not None else None,
    }


class RiverPathRequest(BaseModel):
    points: List[str]
    river_name: Optional[str] = None


@router.post("/river-path")
def river_path(req: RiverPathRequest, user: dict = Depends(get_current_user)):
    """Best-effort "assumed path down the river" between two points, stitched
    from OpenStreetMap waterway geometry (free, no key). Item-agnostic, like
    /geocode and /route-distance — the "Generate river path" button lives in
    the edit form, which may be a not-yet-saved new item.
    """
    if len(req.points) != 2:
        raise HTTPException(status_code=400, detail="Need exactly an origin and a destination")
    try:
        return estimate_river_path(req.points[0], req.points[1], req.river_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except NoPlausiblePath as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"River path lookup failed: {e}")


_STATIC_MAPS_KEY = os.getenv("GOOGLE_STATIC_MAPS_API_KEY", "") or _ROUTES_KEY
_STATIC_MAPS_API = "https://maps.googleapis.com/maps/api/staticmap"


def _static_map_png(path: list, start: Optional[str], end: Optional[str], color: str = "0x1f7a6cff") -> Response:
    """Proxy a Google Static Maps image tracing `path`, so the Google API key
    never reaches the frontend (same convention as every other Google API
    usage in this app — /geocode, /route-distance)."""
    if not _STATIC_MAPS_KEY:
        raise HTTPException(status_code=503, detail="Static Maps not configured (set GOOGLE_STATIC_MAPS_API_KEY)")

    encoded = _encode_polyline([(p[0], p[1]) for p in path])
    params = {
        "size": "640x400",
        "maptype": "roadmap",
        "path": f"color:{color}|weight:4|enc:{encoded}",
        "key": _STATIC_MAPS_KEY,
    }
    query_parts = [urllib.parse.urlencode(params)]
    if start:
        query_parts.append(urllib.parse.urlencode({"markers": f"color:green|label:A|{start}"}))
    if end:
        query_parts.append(urllib.parse.urlencode({"markers": f"color:red|label:B|{end}"}))
    url = f"{_STATIC_MAPS_API}?{'&'.join(query_parts)}"

    try:
        with httpx.Client(timeout=15) as client:
            resp = client.get(url)
            resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        # Google's Static Maps error responses are plain text/HTML explaining
        # exactly why (key restricted to other APIs, API not enabled on the
        # project, billing not enabled, etc.) — surface it instead of the
        # generic httpx message so this doesn't need another guess-and-check
        # round trip.
        body = e.response.text.strip()
        detail = f"Static Maps request failed: {e.response.status_code} {e.response.reason_phrase}"
        if body:
            detail += f" — {body[:300]}"
        record_external_call("google_static_maps", ok=False, error=detail)
        raise HTTPException(status_code=503, detail=detail)
    except Exception as e:
        record_external_call("google_static_maps", ok=False, error=str(e))
        raise HTTPException(status_code=503, detail=f"Static Maps request failed: {e}")
    record_external_call("google_static_maps", ok=True)

    etag = hashlib.sha256(json.dumps([path, start, end]).encode()).hexdigest()[:16]
    return Response(
        content=resp.content,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=86400", "ETag": etag},
    )


@router.get("/items/{item_id}/river-map")
def river_map(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Item-scoped (reads the stored details rather than accepting arbitrary
    path/point query params) so this can't be hammered with arbitrary huge
    payloads against a billed API by anyone who isn't at least a trip viewer.
    """
    require_item_role(session, user, item_id, TripRole.viewer)
    item = session.get(ItineraryItem, item_id)
    if not item or item.kind != "river_transfer":
        raise HTTPException(status_code=404, detail="River transfer item not found")
    details = item.details or {}
    path = details.get("river_path") or []
    if len(path) < 2:
        raise HTTPException(status_code=404, detail="No river path generated for this item yet")
    return _static_map_png(path, details.get("start_location"), details.get("end_location"))


@router.get("/items/{item_id}/gpx-map")
def gpx_map(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Proxy a Static Maps image tracing the item's actual recorded/generated
    GPX track (details.gpx_route) — the literal path, unlike the Directions-
    embed the card falls back to, which recomputes a route between named
    waypoints and can diverge from what was actually walked or ridden."""
    require_item_role(session, user, item_id, TripRole.viewer)
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    details = item.details or {}
    path = details.get("gpx_route") or []
    if len(path) < 2:
        raise HTTPException(status_code=404, detail="No GPX route stored for this item yet")
    return _static_map_png(path, details.get("start_location"), details.get("end_location"), color="0x2563ebff")


_ENRICHABLE_KINDS = {ItemKind.accommodation, ItemKind.restaurant, ItemKind.activity, ItemKind.show, ItemKind.tour}


@router.get("/stops/{stop_id}/enrich")
def enrich_place(
    stop_id: int, kind: ItemKind, name: str, location: str = "",
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    """Google Places autofill from in-progress form fields — works before the
    item is saved (no item_id needed), so filling doesn't require a
    save/reload/fill round trip."""
    require_stop_role(session, user, stop_id, TripRole.editor)
    if not _PLACES_KEY:
        raise HTTPException(status_code=503, detail="Google Places API not configured")
    if kind not in _ENRICHABLE_KINDS:
        raise HTTPException(status_code=400, detail="Item kind is not enrichable")
    if not name.strip():
        raise HTTPException(status_code=400, detail="Name is required")

    query = name if not location.strip() else f"{name} {location}"

    with httpx.Client(timeout=8) as client:
        # 1. Find the place
        try:
            search = client.get(f"{_PLACES_BASE}/findplacefromtext/json", params={
                "input": query,
                "inputtype": "textquery",
                "fields": "place_id",
                "key": _PLACES_KEY,
            }).json()
        except Exception as e:
            record_external_call("google_places", ok=False, error=str(e))
            raise
        record_external_call("google_places", ok=True)
        candidates = search.get("candidates", [])
        if not candidates:
            raise HTTPException(status_code=404, detail="Place not found")

        # 2. Get place details
        place_id = candidates[0]["place_id"]
        try:
            det = client.get(f"{_PLACES_BASE}/details/json", params={
                "place_id": place_id,
                "fields": "name,formatted_address,formatted_phone_number,international_phone_number,website,editorial_summary",
                "key": _PLACES_KEY,
            }).json().get("result", {})
        except Exception as e:
            record_external_call("google_places", ok=False, error=str(e))
            raise
        record_external_call("google_places", ok=True)

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

        try:
            with httpx.Client(timeout=25) as client:
                resp = client.post(_TOPO_API, json={"locations": locs})
                resp.raise_for_status()
                results = resp.json().get("results", [])
        except Exception as e:
            record_external_call("opentopodata", ok=False, error=str(e))
            raise
        record_external_call("opentopodata", ok=True)

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

def _decimate_coords(coords: list, max_points: int = 300) -> list:
    """Evenly sample down to at most max_points, always keeping the first and
    last point, so a long recorded track stays a reasonable Static Maps URL
    size without distorting its overall shape."""
    if len(coords) <= max_points:
        return coords
    step = (len(coords) - 1) / (max_points - 1)
    return [coords[round(i * step)] for i in range(max_points)]


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
        gpx_route = [[lat, lon] for lat, lon, _ in _decimate_coords(coords)]
        dist = sum(_haversine(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
                   for i in range(len(coords)-1))
        gain = loss = 0.0
        for i in range(1, len(coords)):
            if coords[i][2] is not None and coords[i-1][2] is not None:
                d = coords[i][2] - coords[i-1][2]
                if d > 0: gain += d
                else: loss += abs(d)
        stats = {'gpx_distance_m': round(dist), 'gpx_gain_m': round(gain), 'gpx_loss_m': round(loss), 'gpx_route': gpx_route}
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
async def upload_gpx(item_id: int, file: UploadFile = File(...), session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_item_role(session, user, item_id, TripRole.editor)
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
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
        if stats.get(key):
            details[key] = stats[key]  # a (re-)uploaded track — overwrite
    details['gpx_distance_m'] = stats.get('gpx_distance_m')
    details['gpx_gain_m']     = stats.get('gpx_gain_m')
    details['gpx_loss_m']     = stats.get('gpx_loss_m')
    details['gpx_route']      = stats.get('gpx_route')
    item.details = details
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


class RouteGpxRequest(BaseModel):
    points: List[str]
    mode: str = "cycling"


def _coords_to_gpx(name, coords):
    """Build a minimal GPX 1.1 track from decoded (lat, lng) route points."""
    safe = (name or "Route").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    trkpts = "".join(f'<trkpt lat="{lat}" lon="{lng}"></trkpt>' for lat, lng in coords)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="TravelCompanion" xmlns="http://www.topografix.com/GPX/1/1">'
        f'<trk><name>{safe}</name><trkseg>{trkpts}</trkseg></trk></gpx>'
    ).encode()


@router.post("/items/{item_id}/route-gpx", response_model=ItemRead)
def route_to_gpx(item_id: int, req: RouteGpxRequest, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """Generate and store a GPX track for an item from the Google Routes geometry —
    the same route used for the distance calculation. Adds elevation and stats just
    like an uploaded GPX, overwriting distance/elevation with the route's values."""
    require_item_role(session, user, item_id, TripRole.editor)
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    route = _fetch_route(req.points, req.mode)
    encoded = (route.get("polyline") or {}).get("encodedPolyline")
    coords = _decode_polyline(encoded) if encoded else []
    if len(coords) < 2:
        raise HTTPException(status_code=422, detail="Route had no usable geometry to convert")

    content = _add_elevation_to_gpx(_coords_to_gpx(item.name, coords))
    os.makedirs(_GPX_DIR, exist_ok=True)
    with open(os.path.join(_GPX_DIR, f"{item_id}.gpx"), 'wb') as f:
        f.write(content)

    details = dict(item.details or {})
    details['gpx_filename'] = f"{item_id}.gpx"
    details['original_gpx_name'] = f"{item.name or 'route'}.gpx"
    stats = _extract_gpx_stats(content)
    for key in ('distance', 'elevation_gain', 'elevation_loss'):
        if stats.get(key):
            details[key] = stats[key]  # generated from the route — overwrite
    details['gpx_distance_m'] = stats.get('gpx_distance_m')
    details['gpx_gain_m']     = stats.get('gpx_gain_m')
    details['gpx_loss_m']     = stats.get('gpx_loss_m')
    details['gpx_route']      = stats.get('gpx_route')
    item.details = details
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.get("/items/{item_id}/gpx")
def download_gpx(item_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_item_role(session, user, item_id, TripRole.viewer)
    item = session.get(ItineraryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    details = item.details or {}
    fp = os.path.join(_GPX_DIR, f"{item_id}.gpx")
    if not os.path.exists(fp):
        raise HTTPException(status_code=404, detail="No GPX file uploaded")
    return FileResponse(fp, media_type='application/gpx+xml',
                        filename=details.get('original_gpx_name', 'route.gpx'))


# ── Laundry facility lookup ────────────────────────────────────────────────────

def _make_wash_entry(name: str, address: str, *, rating=None, review_count=None,
                     distance_m=None, hours=None, open_24hrs=False,
                     place_id=None) -> dict:
    """Build a single washing-facilities dict with all required fields."""
    return {
        "name":               name,
        "address":            address,
        "rating":             rating,
        "review_count":       review_count,
        "distance_m":         distance_m,
        "hours":              hours,
        "open_24hrs":         open_24hrs,
        "top_pick":           False,
        "cash_card":          None,   # unknown — user fills in
        "detergent_included": None,   # unknown — user fills in
        "key_notes":          "",
        "warnings":           "",
        "place_id":           place_id,
    }


def _mark_top_picks(entries: list, threshold_m: int = 500) -> list:
    """Mark the best laundromat as top_pick.

    Prefers the highest-rated option within `threshold_m` metres.
    Falls back to the closest option if none are rated.
    """
    for e in entries:
        e["top_pick"] = False

    candidates = [e for e in entries if (e.get("distance_m") or 9999) <= threshold_m]
    if not candidates:
        candidates = entries

    rated = [e for e in candidates if e.get("rating") is not None]
    winner = max(rated, key=lambda e: e["rating"]) if rated else (
             min(candidates, key=lambda e: e.get("distance_m") or 9999) if candidates else None)
    if winner:
        winner["top_pick"] = True
    return entries


def _places_nearby_laundry(lat: float, lng: float, radius: int = 1000) -> list:
    """Call Google Places nearbysearch for laundromats. Returns raw results list."""
    url = f"{_PLACES_BASE}/nearbysearch/json"
    params = {
        "location": f"{lat},{lng}",
        "radius": radius,
        "keyword": "laundromat laundry coin laundry",
        "key": _PLACES_KEY,
    }
    try:
        with httpx.Client(timeout=10) as client:
            r = client.get(url, params=params)
            r.raise_for_status()
            results = r.json().get("results", [])
    except Exception as e:
        record_external_call("google_places", ok=False, error=str(e))
        return []
    record_external_call("google_places", ok=True)
    return results


def _places_detail(place_id: str) -> dict:
    """Fetch Place Details for opening hours and reviews."""
    url = f"{_PLACES_BASE}/details/json"
    params = {
        "place_id": place_id,
        "fields": "opening_hours,formatted_address,reviews",
        "key": _PLACES_KEY,
    }
    try:
        with httpx.Client(timeout=8) as client:
            r = client.get(url, params=params)
            r.raise_for_status()
            result = r.json().get("result", {})
    except Exception as e:
        record_external_call("google_places", ok=False, error=str(e))
        return {}
    record_external_call("google_places", ok=True)
    return result


def _nominatim_geocode(q: str) -> tuple | None:
    """Return (lat, lng) for a query string via Nominatim, or None."""
    try:
        with httpx.Client(timeout=8, headers=_NOMINATIM_HEADERS) as client:
            r = client.get(_NOMINATIM, params={"q": q, "format": "json", "limit": 1})
            results = r.json()
    except Exception as e:
        record_external_call("nominatim", ok=False, error=str(e))
        return None
    record_external_call("nominatim", ok=True)
    if results:
        return float(results[0]["lat"]), float(results[0]["lon"])
    return None


def _apply_claude_enhancements(entries: list, raw_enhancements: list) -> list:
    """Apply Claude's extracted fields to the entries list in-place.

    raw_enhancements is the parsed JSON array Claude returned, each element:
    {index, cash_card, detergent_included, open_24hrs, key_notes, warnings}
    """
    for enh in raw_enhancements:
        idx = enh.get("index", -1)
        if not isinstance(idx, int) or not (0 <= idx < len(entries)):
            continue
        e = entries[idx]
        e["cash_card"]          = enh.get("cash_card") or None
        e["detergent_included"] = enh.get("detergent_included")
        # Never downgrade a confirmed open-24hrs flag
        if enh.get("open_24hrs") and not e.get("open_24hrs"):
            e["open_24hrs"] = True
        e["key_notes"] = enh.get("key_notes") or ""
        e["warnings"]  = enh.get("warnings")  or ""
        e.pop("_reviews", None)   # remove internal field before storing

    # Ensure _reviews is stripped from any entries not covered by enhancements
    for e in entries:
        e.pop("_reviews", None)

    return entries


def _claude_enhance_washing(entries: list, city: str = "") -> list:
    """Call Claude Haiku to fill cash/card, detergent, key_notes, warnings
    from Place reviews + general knowledge of the location.

    Skips silently if ANTHROPIC_API_KEY is unset or on any error.
    """
    _key = os.getenv("ANTHROPIC_API_KEY", "")
    if not _key or not entries:
        _apply_claude_enhancements(entries, [])
        return entries

    place_summaries = []
    for i, e in enumerate(entries):
        reviews = e.get("_reviews") or "No reviews available"
        place_summaries.append(
            f"[{i}] {e['name']}\n"
            f"Address: {e['address']}\n"
            f"Hours: {e.get('hours') or 'Unknown'}\n"
            f"Currently 24hr: {e.get('open_24hrs', False)}\n"
            f"Reviews: {reviews}"
        )

    prompt = (
        f"You are a travel assistant helping a tourist find laundromats"
        f"{' in ' + city if city else ''}. "
        "For each laundromat below, analyse the reviews and your knowledge to fill in:\n"
        "- cash_card: 'Cash only', 'Card only', 'Both', or null if genuinely unknown\n"
        "- detergent_included: true if detergent/soap is available on-site (sold or free); "
        "false if BYOS (bring your own soap); null if unknown\n"
        "- open_24hrs: true/false — upgrade to true if reviews or hours confirm it\n"
        "- key_notes: 1-2 short practical notes for a traveller "
        "(machine counts, self-service vs attended, waiting time etc). Empty string if nothing useful.\n"
        "- warnings: any practical warning (e.g. 'Cash only — nearest ATM 200m', "
        "'Very busy Sunday mornings'). Empty string if none.\n\n"
        "Return ONLY a JSON array — no commentary. One object per laundromat in the same order:\n"
        '[{"index":0,"cash_card":"...","detergent_included":true,"open_24hrs":false,'
        '"key_notes":"...","warnings":"..."},...]\n\n'
        "Laundromats:\n" + "\n\n".join(place_summaries)
    )

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=_key)
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1500,
            messages=[{"role": "user", "content": prompt}],
        )
        text = next((b.text for b in resp.content if b.type == "text"), "").strip()
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text).strip()
        raw = json.loads(text)
        record_external_call("anthropic", ok=True)
        _apply_claude_enhancements(entries, raw)
    except Exception as exc:
        record_external_call("anthropic", ok=False, error=str(exc))
        _apply_claude_enhancements(entries, [])

    return entries


@router.post("/items/{item_id}/wash-lookup", include_in_schema=False, response_model=ItemRead)
def wash_lookup(item_id: int, address: str = "", session: Session = Depends(get_session),
                user: dict = Depends(get_current_user)):
    """Find nearby laundry facilities for an accommodation item and store them.

    Not exposed in the public API schema — called from the edit modal.
    Results are stored in details.washing and the updated item is returned.
    """
    require_item_role(session, user, item_id, TripRole.editor)
    if not _PLACES_KEY:
        raise HTTPException(status_code=503,
                            detail="Laundry lookup requires GOOGLE_PLACES_API_KEY")

    item = session.get(ItineraryItem, item_id)
    if not item or item.kind != "accommodation":
        raise HTTPException(status_code=400, detail="Item must be an accommodation")

    d = item.details or {}

    # Resolve coordinates — most-specific source first:
    # 0. address query param (caller passes the unsaved form value)
    # 1. Explicit lat/lng on the item (most accurate)
    # 2. Geocode the hotel's street address from DB
    # 3. Stop lat/lng as a city-level fallback
    # 4. Geocode from hotel name as last resort
    lat = lng = None

    if address.strip():
        coords = _nominatim_geocode(address.strip())
        if coords:
            lat, lng = coords

    for lk, gk in (("lat", "lng"), ("latitude", "longitude")):
        if lat is not None:
            break
        if d.get(lk) and d.get(gk):
            try:
                lat, lng = float(d[lk]), float(d[gk])
                break
            except (ValueError, TypeError):
                pass

    if lat is None and d.get("location"):
        coords = _nominatim_geocode(d["location"])
        if coords:
            lat, lng = coords

    if lat is None:
        stop = session.get(Stop, item.stop_id)
        if stop and stop.lat and stop.lng:
            try:
                lat, lng = float(stop.lat), float(stop.lng)
            except (ValueError, TypeError):
                pass

    if lat is None and item.name:
        coords = _nominatim_geocode(item.name)
        if coords:
            lat, lng = coords

    if lat is None:
        raise HTTPException(
            status_code=422,
            detail="Could not determine the accommodation's location — "
                   "use Auto-fill to add an address, or set coordinates manually"
        )
        lat, lng = coords

    # Fetch nearby laundromats
    places = _places_nearby_laundry(lat, lng)
    entries = []
    for p in places[:8]:
        p_lat = p["geometry"]["location"]["lat"]
        p_lng = p["geometry"]["location"]["lng"]
        dist  = round(_haversine(lat, lng, p_lat, p_lng))

        # Fetch opening hours from Place Details
        pid    = p.get("place_id")
        hours  = None
        open24 = False
        reviews_text = None
        if pid:
            det = _places_detail(pid)
            oh  = det.get("opening_hours", {})
            wt  = oh.get("weekday_text", [])
            hours = wt if wt else None   # array — filtered at display time to stay days
            for period in oh.get("periods", []):
                if period.get("open", {}).get("time") == "0000" and "close" not in period:
                    open24 = True
                    break
            raw_reviews = det.get("reviews", [])
            if raw_reviews:
                reviews_text = " | ".join(
                    f"\"{r.get('text', '')}\"" for r in raw_reviews[:5] if r.get("text")
                )

        entry = _make_wash_entry(
            name         = p.get("name", ""),
            address      = p.get("vicinity", ""),
            rating       = p.get("rating"),
            review_count = p.get("user_ratings_total"),
            distance_m   = dist,
            hours        = hours,
            open_24hrs   = open24,
            place_id     = pid,
        )
        if reviews_text:
            entry["_reviews"] = reviews_text   # temporary — stripped before storage
        entries.append(entry)

    entries.sort(key=lambda e: e.get("distance_m") or 9999)
    entries = _mark_top_picks(entries)

    # Enhance with Claude — fills cash/card, detergent, key_notes, warnings from reviews
    stop = session.get(Stop, item.stop_id)
    city = (stop.location if stop else "") or ""
    entries = _claude_enhance_washing(entries, city=city)

    details           = dict(d)
    details["washing"] = entries
    item.details       = details
    flag_modified(item, "details")
    session.add(item)
    session.commit()
    session.refresh(item)
    return item
