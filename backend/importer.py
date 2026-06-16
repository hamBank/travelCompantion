"""
Seed the database from the existing Google Sheets CSV format.

Usage:
    from backend.importer import import_sheets
    trip = import_sheets(session, "Europe 2026", {"Paris-1": "<csv>", ...})
"""

import csv
import io
from datetime import datetime
from typing import Optional
from sqlmodel import Session

from .models import Trip, Stop, ItineraryItem, StopStatus, ItemKind, ItemStatus


def _rows(text: str) -> list:
    return list(csv.reader(io.StringIO(text)))


def _cell(rows, r, c, default="") -> str:
    try:
        return rows[r][c].strip()
    except (IndexError, AttributeError):
        return default


def _parse_date(s: str) -> Optional[datetime]:
    if not s:
        return None
    for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y", "%d %B %Y", "%d %b %Y",
                "%B %d, %Y", "%b %d, %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except ValueError:
            continue
    return None


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


def import_sheets(session: Session, trip_name: str, sheets_raw: dict[str, str]) -> Trip:
    """
    Create a Trip + Stops + ItineraryItems from {sheet_name: csv_text}.
    Returns the committed Trip with its id populated.
    """
    trip = Trip(name=trip_name)
    session.add(trip)
    session.flush()

    for order, (sheet_name, csv_text) in enumerate(sheets_raw.items()):
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

    session.commit()
    session.refresh(trip)
    return trip
