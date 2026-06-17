"""
Seed the database from the existing Google Sheets CSV format.

Usage:
    from backend.importer import import_sheets
    trip = import_sheets(session, "Europe 2026", {"Paris-1": "<csv>", ...})
"""

import csv
import io
import re
from datetime import datetime
from typing import Optional
from sqlmodel import Session

# Matches bare time strings like "21:35", "9:35 PM", "09:35:00"
_TIME_RE = re.compile(r'^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$', re.IGNORECASE)

from .models import Trip, Stop, ItineraryItem, StopStatus, ItemKind, ItemStatus

# Sheet names that contain tabular flight data (one row per flight, first row is headers)
FLIGHT_SHEET_NAMES = frozenset({"flights", "flight"})

# Maps common IATA codes to city name fragments for stop matching
_IATA_CITY = {
    "sin": "singapore",
    "cdg": "paris", "ory": "paris",
    "fco": "rome", "cia": "rome",
    "bri": "bari",
    "nap": "naples",
    "gva": "geneva",
    "lys": "lyon",
    "hel": "helsinki",
    "mxp": "milan", "lin": "milan",
    "ams": "amsterdam",
    "lhr": "london", "lgw": "london", "stn": "london",
    "bcn": "barcelona",
    "mad": "madrid",
    "dub": "dublin",
    "vie": "vienna",
    "zrh": "zurich",
    "fra": "frankfurt",
    "muc": "munich",
    "cph": "copenhagen",
    "arn": "stockholm",
    "osl": "oslo",
    "bud": "budapest",
    "prg": "prague",
    "waw": "warsaw",
    "nce": "nice",
    "mrs": "marseille",
    "tls": "toulouse",
    "bod": "bordeaux",
    "lis": "lisbon",
    "opo": "porto",
    "ath": "athens",
    "ist": "istanbul",
    "dxb": "dubai",
    "bkk": "bangkok",
    "hkg": "hong kong",
    "nrt": "tokyo", "hnd": "tokyo",
    "icn": "seoul",
    "pek": "beijing", "pkx": "beijing",
    "pvg": "shanghai",
    "syd": "sydney",
    "mel": "melbourne",
    "per": "perth",
    "auh": "abu dhabi",
}

# Maps lowercase column header variants to canonical field names
_HEADER_MAP = {
    "origin": "origin",
    "from": "origin",
    "departure city": "origin",
    "depart city": "origin",
    "dep city": "origin",
    "destination": "destination",
    "to": "destination",
    "arrival city": "destination",
    "arrive city": "destination",
    "arr city": "destination",
    "flight": "flight_number",
    "flight number": "flight_number",
    "flight no": "flight_number",
    "flight_number": "flight_number",
    "flightno": "flight_number",
    "airline": "airline",
    "carrier": "airline",
    "depart date": "depart_date",
    "departure date": "depart_date",
    "dep date": "depart_date",
    "depart_date": "depart_date",
    "depart time": "depart_time_raw",
    "departure time": "depart_time_raw",
    "dep time": "depart_time_raw",
    "depart_time": "depart_time_raw",
    "depart tz": "depart_tz",
    "departure tz": "depart_tz",
    "dep tz": "depart_tz",
    "depart timezone": "depart_tz",
    "arrive date": "arrive_date",
    "arrival date": "arrive_date",
    "arr date": "arrive_date",
    "arrive_date": "arrive_date",
    "arrive time": "arrive_time_raw",
    "arrival time": "arrive_time_raw",
    "arr time": "arrive_time_raw",
    "arrive_time": "arrive_time_raw",
    "arrive tz": "arrive_tz",
    "arrival tz": "arrive_tz",
    "arr tz": "arrive_tz",
    "arrive timezone": "arrive_tz",
    "duration": "duration",
    "stops": "stops",
    "terminal": "origin_terminal",
    "origin terminal": "origin_terminal",
    "departure terminal": "origin_terminal",
    "dep terminal": "origin_terminal",
    "fare class": "fare_class",
    "class": "fare_class",
    "cabin class": "fare_class",
    "cabin": "fare_class",
    "fare_class": "fare_class",
    "seats": "seats",
    "seat": "seats",
    "seat numbers": "seats",
    "aircraft": "aircraft",
    "plane": "aircraft",
    "aircraft type": "aircraft",
    "booking ref": "booking_ref",
    "confirmation": "booking_ref",
    "confirmation no": "booking_ref",
    "ref": "booking_ref",
    "pnr": "booking_ref",
    "booking_ref": "booking_ref",
    "cost": "cost",
    "total cost": "cost",
    "price": "cost",
    "amount": "cost",
    "fare": "cost",
    "passengers": "passengers",
    "travellers": "passengers",
    "traveler names": "passengers",
    "pax": "passengers",
    "layover": "layover",
    "layover time": "layover",
    "connects to": "connects_to",
    "connects_to": "connects_to",
    "connection": "connects_to",
    "connecting flight": "connects_to",
    "booking airline": "booking_airline",
    "booked with": "booking_airline",
    "booking_airline": "booking_airline",
    "booked through": "booking_airline",
    "booking url": "booking_url",
    "booking link": "booking_url",
    "url": "booking_url",
    "booking phone": "booking_phone",
    "contact phone": "booking_phone",
    "phone": "booking_phone",
    "distance": "distance",
    "date": "depart_date",
    "departure": "depart_time_raw",
    "arrival": "arrive_time_raw",
    "status": "flight_status",
    "checkin": "checkin",
    "lounge": "lounge",
    "food": "meal",
    "baggage": "baggage",
    "bags": "baggage",
    "baggage allowance": "baggage",
    "meal": "meal",
    "meals": "meal",
    "entertainment": "entertainment",
    "ife": "entertainment",
    "loyalty": "loyalty_info",
    "loyalty numbers": "loyalty_info",
    "loyalty_info": "loyalty_info",
    "frequent flyer": "loyalty_info",
    "ffn": "loyalty_info",
    "stop": "stop_location",
    "location": "stop_location",
    "stop location": "stop_location",
    "city": "stop_location",
    "departure stop": "stop_location",
    "label": "label",
    "name": "label",
    "notes": "notes",
}


def _rows(text: str) -> list:
    return list(csv.reader(io.StringIO(text)))


def _cell(rows, r, c, default="") -> str:
    try:
        return rows[r][c].strip()
    except (IndexError, AttributeError):
        return default


def _infer_year(month: int, day: int) -> int:
    """Pick the year (current or ±1) that puts month/day closest to today."""
    today = datetime.today()
    best_year, best_delta = today.year, None
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            delta = abs((datetime(year, month, day) - today).days)
            if best_delta is None or delta < best_delta:
                best_year, best_delta = year, delta
        except ValueError:
            continue
    return best_year


def _parse_date(s: str) -> Optional[datetime]:
    if not s:
        return None
    s = s.strip()
    for fmt in (
        # ISO
        "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
        # DD/MM/YYYY
        "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y %H.%M", "%d/%m/%Y",
        # MM/DD/YYYY (US)
        "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y",
        # DD Mon YYYY
        "%d %B %Y %H:%M", "%d %B %Y",
        "%d %b %Y %H:%M", "%d %b %Y",
        "%d-%b-%Y %H:%M", "%d-%b-%Y",
        "%d %b %y %H:%M", "%d %b %y",
        # Mon DD, YYYY
        "%B %d, %Y %H:%M", "%B %d, %Y",
        "%b %d, %Y %H:%M", "%b %d, %Y",
    ):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    # AM/PM formats — normalise to uppercase first
    su = s.upper()
    for fmt in (
        "%d/%m/%Y %I:%M %p", "%d/%m/%Y %I:%M%p",
        "%m/%d/%Y %I:%M %p", "%m/%d/%Y %I:%M%p",
        "%d %b %Y %I:%M %p", "%d %b %Y %I:%M%p",
        "%Y-%m-%d %I:%M %p", "%Y-%m-%d %I:%M%p",
    ):
        try:
            return datetime.strptime(su, fmt)
        except ValueError:
            continue
    # Short date formats with no year — infer year from proximity to today
    # e.g. "Wed 22/7", "22/7", "22 Jul", "Wed 22 Jul"
    for fmt in ("%a %d/%m", "%d/%m", "%a %d %b", "%d %b", "%b %d", "%a %b %d"):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.replace(year=_infer_year(dt.month, dt.day))
        except ValueError:
            continue
    return None


def _overlay_time(dt: datetime, time_str: str) -> datetime:
    """Overlay an HH:MM (or H:MM AM/PM) string onto an existing datetime."""
    if not time_str:
        return dt
    m = _TIME_RE.match(time_str.strip())
    if not m:
        return dt
    h, mi = int(m.group(1)), int(m.group(2))
    meridiem = (m.group(3) or '').upper()
    if meridiem == 'PM' and h < 12:
        h += 12
    elif meridiem == 'AM' and h == 12:
        h = 0
    return dt.replace(hour=h, minute=mi, second=0, microsecond=0)


def _combine_datetime(date_str: str, time_str: str) -> str:
    """Parse date + time strings and return ISO 'YYYY-MM-DDTHH:MM' or ''."""
    # Try time_str as a standalone datetime (e.g. "24/07/2025 21:35")
    if time_str:
        dt = _parse_date(time_str)
        if dt:
            return dt.strftime("%Y-%m-%dT%H:%M")
    # Try the combined string (works when both are full date+time components)
    if date_str and time_str:
        dt = _parse_date(f"{date_str} {time_str}")
        if dt:
            return dt.strftime("%Y-%m-%dT%H:%M")
    # Parse date alone, then overlay the bare time (e.g. "Wed 22/7" + "21:35")
    if date_str:
        dt = _parse_date(date_str)
        if dt:
            dt = _overlay_time(dt, time_str)
            return dt.strftime("%Y-%m-%dT%H:%M")
    return ""


def _find_stop_for_flight(stops: list, origin: str, stop_location_hint: str, depart_iso: str = "") -> Optional[Stop]:
    """Return the best Stop to attach a flight to.

    Priority:
    1. Explicit stop_location hint column
    2. Flight departure date falls within stop.arrive … stop.depart
    3. Flight departure date matches stop.depart (same day)
    4. Last stop that had already started before the flight departed
    5. City / IATA name matching
    6. First stop fallback
    """
    if not stops:
        return None

    # 1. Explicit stop_location column wins
    if stop_location_hint:
        hint = stop_location_hint.lower()
        for stop in stops:
            if hint in stop.location.lower() or stop.location.lower() in hint:
                return stop

    # Date-based strategies
    if depart_iso:
        try:
            flight_dt = datetime.fromisoformat(depart_iso)
            flight_date = flight_dt.date()

            # 2. Exact date-range: arrive ≤ flight ≤ depart
            for stop in stops:
                if stop.arrive and stop.depart:
                    if stop.arrive.date() <= flight_date <= stop.depart.date():
                        return stop

            # 3. Same day as stop departure (flight out on check-out day)
            for stop in stops:
                if stop.depart and stop.depart.date() == flight_date:
                    return stop

            # 4. Last stop that had already started (arrive ≤ flight)
            candidates = [s for s in stops if s.arrive and s.arrive.date() <= flight_date]
            if candidates:
                return max(candidates, key=lambda s: s.arrive)

        except (ValueError, TypeError, AttributeError):
            pass

    # 5. City / IATA name matching
    if origin:
        origin_lower = origin.lower().strip()

        for stop in stops:
            if origin_lower == stop.location.lower():
                return stop

        for stop in stops:
            loc = stop.location.lower()
            if loc in origin_lower or origin_lower in loc:
                return stop

        city = _IATA_CITY.get(origin_lower, "")
        if city:
            for stop in stops:
                if city in stop.location.lower():
                    return stop

    # 6. Default to first stop
    return stops[0]


def _parse_flights_sheet(csv_text: str) -> list[dict]:
    """
    Parse a Flights sheet with header row + one flight per row.
    Returns a list of flight dicts with canonical field names.
    """
    rows = _rows(csv_text)
    if len(rows) < 2:
        return []

    # Build column → field mapping from first row
    raw_headers = [h.lower().strip() for h in rows[0]]
    col_to_field: dict[int, str] = {}
    for col_idx, header in enumerate(raw_headers):
        field = _HEADER_MAP.get(header)
        if field:
            col_to_field[col_idx] = field

    def get(row: list, field: str) -> str:
        for col_idx, f in col_to_field.items():
            if f == field and col_idx < len(row):
                return row[col_idx].strip()
        return ""

    flights = []
    for row in rows[1:]:
        if not any(cell.strip() for cell in row):
            continue

        origin = get(row, "origin")
        destination = get(row, "destination")
        if not origin and not destination:
            continue

        depart_date = get(row, "depart_date")
        depart_iso = _combine_datetime(depart_date, get(row, "depart_time_raw"))
        # Use depart_date as fallback arrive_date (no separate arrive_date column)
        arrive_iso = _combine_datetime(
            get(row, "arrive_date") or depart_date,
            get(row, "arrive_time_raw"),
        )

        # Detect overnight flights: if arrival parses earlier than departure, add 1 day
        if depart_iso and arrive_iso:
            try:
                from datetime import timedelta
                d_dt = datetime.fromisoformat(depart_iso)
                a_dt = datetime.fromisoformat(arrive_iso)
                if a_dt < d_dt:
                    arrive_iso = (a_dt + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M")
            except ValueError:
                pass

        label = get(row, "label") or f"{origin} → {destination}"

        details = {}
        for field in (
            "origin", "destination", "flight_number", "airline",
            "depart_tz", "arrive_tz", "duration", "stops", "origin_terminal",
            "fare_class", "seats", "aircraft", "booking_ref", "booking_airline",
            "booking_phone", "passengers", "loyalty_info", "layover", "connects_to",
            "distance", "baggage", "meal", "entertainment", "notes",
            "flight_status", "checkin", "lounge",
        ):
            val = get(row, field)
            if val:
                details[field] = val

        if depart_iso:
            details["depart_time"] = depart_iso
        if arrive_iso:
            details["arrive_time"] = arrive_iso

        flights.append({
            "label": label,
            "cost": get(row, "cost"),
            "booking_url": get(row, "booking_url"),
            "stop_location": get(row, "stop_location"),
            "origin": origin,
            "details": details,
        })

    return flights


def update_stop_dates(session: Session, trip_id: int, sheets_raw: dict[str, str]) -> dict:
    """
    Patch arrive/depart on existing stops from the location sheets.
    Strategy: sort_order match first, location-name fallback.
    Does not touch items or recreate stops.
    Returns {"stops_updated": N, "detail": [...]} with per-sheet diagnostics.
    """
    from collections import defaultdict
    from sqlmodel import select

    all_stops = list(session.exec(select(Stop).where(Stop.trip_id == trip_id)).all())
    if not all_stops:
        raise ValueError(f"No stops found for trip {trip_id}")

    stops_by_order = {s.sort_order: s for s in all_stops}
    # location → stops sorted by sort_order (handles duplicate city names like Paris)
    stops_by_location: dict[str, list] = defaultdict(list)
    for s in sorted(all_stops, key=lambda x: x.sort_order):
        stops_by_location[s.location.lower()].append(s)
    location_usage: dict[str, int] = defaultdict(int)

    updated = 0
    detail = []
    for order, (sheet_name, csv_text) in enumerate(sheets_raw.items()):
        if sheet_name.lower() in FLIGHT_SHEET_NAMES:
            continue
        data = _parse_sheet(sheet_name, csv_text)
        location = data.get("location", "")
        if not location:
            detail.append({"sheet": sheet_name, "status": "skipped — no location in sheet"})
            continue

        # Sort-order match (most reliable when trip was imported with current code)
        stop = stops_by_order.get(order)
        match_method = "sort_order"

        # Location-name fallback (handles re-imports, order drift)
        if stop is None:
            candidates = stops_by_location.get(location.lower(), [])
            idx = location_usage[location.lower()]
            stop = candidates[idx] if idx < len(candidates) else None
            match_method = "location_name"
            if stop:
                location_usage[location.lower()] += 1

        arrive = data.get("arrive")
        depart = data.get("depart")
        row = {
            "sheet": sheet_name,
            "location": location,
            "parsed_arrive": arrive.isoformat() if arrive else None,
            "parsed_depart": depart.isoformat() if depart else None,
            "matched_stop_id": stop.id if stop else None,
            "match_method": match_method if stop else "none",
        }

        if stop is None:
            row["status"] = "no matching stop"
            detail.append(row)
            continue

        changed = False
        if arrive is not None:
            stop.arrive = arrive
            changed = True
        if depart is not None:
            stop.depart = depart
            changed = True

        row["status"] = "updated" if changed else "no dates parsed"
        detail.append(row)
        if changed:
            session.add(stop)
            updated += 1

    session.commit()
    return {"stops_updated": updated, "detail": detail}


def _parse_sheet(sheet_name: str, raw_csv: str) -> dict:
    rows = _rows(raw_csv)
    if not rows:
        return {}

    data = {
        "location": _cell(rows, 0, 0),
        "country": _cell(rows, 0, 1),
        "arrive": None, "depart": None,
        "accommodation": "", "accommodation_link": "", "accommodation_notes": "",
        "check_in": "", "check_out": "",
        "timezone": "0", "lat": "", "lng": "",
        "activities": [], "restaurants": [],
    }

    in_activities = in_restaurants = rest_header = False
    FOOTER = {"local", "tz corrected", "lattitude", "latitude",
              "longatude", "longitude", "timezone", "weather"}

    for i, row in enumerate(rows):
        if not row:
            continue
        c0 = row[0].strip() if row else ""
        c1 = row[1].strip() if len(row) > 1 else ""
        c2 = row[2].strip() if len(row) > 2 else ""

        lc0 = c0.lower()

        if lc0 == "arrive":
            data["arrive"] = _parse_date(c1)
        elif lc0 == "depart":
            data["depart"] = _parse_date(c1)
        elif lc0 in ("accomodation", "accommodation"):
            data["accommodation"] = c1
            data["accommodation_link"] = c2
            if i + 1 < len(rows):
                data["accommodation_notes"] = "  ·  ".join(
                    x.strip() for x in rows[i + 1] if x.strip()
                )
        elif lc0 == "timezone":
            data["timezone"] = c1
        elif "latitude" in lc0 or "lattitude" in lc0:
            if "," in c1:
                parts = c1.split(",", 1)
                data["lat"], data["lng"] = parts[0].strip(), parts[1].strip()
            else:
                data["lat"], data["lng"] = c1, c2
        elif lc0 == "sunrise":
            for j, cell in enumerate(row):
                lc = cell.lower()
                if "check-in" in lc and j + 1 < len(row):
                    data["check_in"] = row[j + 1].strip()
                if "check-out" in lc and j + 1 < len(row):
                    data["check_out"] = row[j + 1].strip()

        if lc0 in FOOTER or c1.lower() in ("utc", "local"):
            in_activities = in_restaurants = False

        if c0 == "" and c1.lower() == "activity":
            in_activities, in_restaurants = True, False
            continue

        if "restaurant" in lc0 and ("type" in c1.lower() or "walk" in c2.lower()):
            in_restaurants, in_activities, rest_header = True, False, True
            continue

        if in_activities and not in_restaurants and c1 and c1.lower() not in ("activity", "link", "cost"):
            c3 = row[3].strip() if len(row) > 3 else ""
            dt = _parse_date(c0)
            time_note = f"{dt.day}/{dt.month}" if dt else c0
            data["activities"].append({"time": time_note, "name": c1, "link": c2, "cost": c3})

        if in_restaurants and rest_header and c1 and c1.lower() not in ("restaurant", "type", "walk"):
            notes = "  ·  ".join(filter(None, [
                c2,
                row[3].strip() if len(row) > 3 else "",
                row[4].strip() if len(row) > 4 else "",
                row[5].strip() if len(row) > 5 else "",
            ]))
            data["restaurants"].append({"name": c1, "notes": notes})

    return data


def import_flights(session: Session, trip_id: int, sheets_raw: dict[str, str]) -> int:
    """
    Attach flights from the Flights sheet to an existing trip's stops.
    Returns the number of flight items created.
    """
    from sqlmodel import select
    stops = list(session.exec(select(Stop).where(Stop.trip_id == trip_id)).all())
    if not stops:
        raise ValueError(f"No stops found for trip {trip_id}")

    count = 0
    for sheet_name, csv_text in sheets_raw.items():
        if sheet_name.lower() not in FLIGHT_SHEET_NAMES:
            continue
        for flight in _parse_flights_sheet(csv_text):
            stop = _find_stop_for_flight(
                stops, flight["origin"], flight["stop_location"],
                flight["details"].get("depart_time", "") if flight["details"] else "",
            )
            if stop is None:
                continue
            session.add(ItineraryItem(
                stop_id=stop.id,
                kind=ItemKind.flight,
                name=flight["label"],
                cost=flight["cost"],
                link=flight["booking_url"],
                status=ItemStatus.pending,
                details=flight["details"] or None,
            ))
            count += 1

    session.commit()
    return count


def import_sheets(session: Session, trip_name: str, sheets_raw: dict[str, str]) -> Trip:
    """
    Create a Trip + Stops + ItineraryItems from {sheet_name: csv_text}.
    Returns the committed Trip with its id populated.
    """
    trip = Trip(name=trip_name)
    session.add(trip)
    session.flush()

    stops: list[Stop] = []

    # First pass: create stops from location sheets
    for order, (sheet_name, csv_text) in enumerate(sheets_raw.items()):
        if sheet_name.lower() in FLIGHT_SHEET_NAMES:
            continue

        data = _parse_sheet(sheet_name, csv_text)
        if not data.get("location"):
            continue

        stop = Stop(
            trip_id=trip.id,
            location=data["location"],
            country=data["country"],
            arrive=data["arrive"],
            depart=data["depart"],
            accommodation=data["accommodation"],
            accommodation_link=data["accommodation_link"],
            accommodation_notes=data["accommodation_notes"],
            check_in=data["check_in"],
            check_out=data["check_out"],
            timezone=data["timezone"],
            lat=data["lat"],
            lng=data["lng"],
            sort_order=order,
            status=StopStatus.planned,
        )
        session.add(stop)
        session.flush()
        stops.append(stop)

        for act in data["activities"]:
            session.add(ItineraryItem(
                stop_id=stop.id,
                kind=ItemKind.activity,
                name=act["name"],
                link=act.get("link", ""),
                cost=act.get("cost", ""),
                notes=act.get("time", ""),
                status=ItemStatus.pending,
            ))

        for rest in data["restaurants"]:
            session.add(ItineraryItem(
                stop_id=stop.id,
                kind=ItemKind.restaurant,
                name=rest["name"],
                notes=rest.get("notes", ""),
                status=ItemStatus.pending,
            ))

    # Second pass: attach flights to the stop they depart from
    for sheet_name, csv_text in sheets_raw.items():
        if sheet_name.lower() not in FLIGHT_SHEET_NAMES:
            continue

        for flight in _parse_flights_sheet(csv_text):
            stop = _find_stop_for_flight(
                stops, flight["origin"], flight["stop_location"],
                flight["details"].get("depart_time", "") if flight["details"] else "",
            )
            if stop is None:
                continue
            session.add(ItineraryItem(
                stop_id=stop.id,
                kind=ItemKind.flight,
                name=flight["label"],
                cost=flight["cost"],
                link=flight["booking_url"],
                status=ItemStatus.pending,
                details=flight["details"] or None,
            ))

    session.commit()
    session.refresh(trip)
    return trip
