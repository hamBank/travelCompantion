from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, SQLModel, select
from ..database import get_session
from ..sheets import fetch_sheets
from ..importer import import_sheets, import_flights, update_stop_dates, enrich_accommodations, _parse_flights_sheet, _assign_flights_to_stops, _parse_date, FLIGHT_SHEET_NAMES
from ..models import TripRead, Stop, ItineraryItem

router = APIRouter(tags=["import"])


class SheetsImportRequest(SQLModel):
    trip_name: str


class SheetsImportResult(TripRead):
    stops_imported: int


@router.post("/import/sheets", response_model=SheetsImportResult, status_code=201)
def import_from_sheets(req: SheetsImportRequest, session: Session = Depends(get_session)):
    try:
        sheets_raw = fetch_sheets()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    trip = import_sheets(session, req.trip_name, sheets_raw)

    stop_count = session.exec(
        select(Stop).where(Stop.trip_id == trip.id)
    ).all()

    return SheetsImportResult(**trip.model_dump(), stops_imported=len(stop_count))


@router.post("/import/sheets/flights/{trip_id}", status_code=200)
def import_flights_only(trip_id: int, session: Session = Depends(get_session)):
    """
    Fetch the Flights sheet and attach flight items to an existing trip's stops.
    Does not create a new trip or touch existing stops/items.
    """
    try:
        sheets_raw = fetch_sheets()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    try:
        count = import_flights(session, trip_id, sheets_raw)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    return {"flights_imported": count}


@router.post("/import/sheets/update-stop-dates/{trip_id}", status_code=200)
def update_stop_dates_from_sheets(trip_id: int, session: Session = Depends(get_session)):
    """
    Re-read arrive/depart dates from the location sheets and patch existing stops.
    Safe to call on a trip that already has manually-edited items — only dates change.
    """
    try:
        sheets_raw = fetch_sheets()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    try:
        result = update_stop_dates(session, trip_id, sheets_raw)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    return result


@router.get("/import/sheets/flights/{trip_id}/preview")
def preview_flight_assignments(trip_id: int, session: Session = Depends(get_session)):
    """
    Dry-run: show which stop each flight would be assigned to, without importing.
    Useful for diagnosing stop-matching issues.
    """
    try:
        sheets_raw = fetch_sheets()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    stops = list(session.exec(select(Stop).where(Stop.trip_id == trip_id)).all())
    if not stops:
        raise HTTPException(status_code=404, detail=f"No stops found for trip {trip_id}")

    all_flights = []
    for sheet_name, csv_text in sheets_raw.items():
        if sheet_name.lower() in FLIGHT_SHEET_NAMES:
            all_flights.extend(_parse_flights_sheet(csv_text))

    results = []
    for flight, stop in _assign_flights_to_stops(all_flights, stops):
        depart_iso = (flight.get("details") or {}).get("depart_time", "")
        results.append({
            "flight": flight["label"],
            "origin": flight["origin"],
            "depart_time": depart_iso,
            "assigned_stop": stop.location if stop else None,
            "stop_arrive": stop.arrive.isoformat() if stop and stop.arrive else None,
            "stop_depart": stop.depart.isoformat() if stop and stop.depart else None,
        })
    return results


@router.get("/import/sheets/preview")
def preview_sheets():
    """
    Return the raw rows from every configured sheet (up to 60 rows each).
    Useful for inspecting the sheet structure before writing parsers.
    Call this locally: GET http://localhost:8000/import/sheets/preview
    """
    try:
        sheets_raw = fetch_sheets()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    import csv, io
    result = {}
    for name, csv_text in sheets_raw.items():
        rows = list(csv.reader(io.StringIO(csv_text)))
        result[name] = rows[:60]          # cap at 60 rows per sheet
    return result


@router.post("/import/backfill-scheduled-at/{trip_id}", status_code=200)
def backfill_scheduled_at(trip_id: int, session: Session = Depends(get_session)):
    """
    For existing activity items that have no scheduled_at but have a date string in
    their notes field (e.g. "24/7 12:00", "Wednesday 22 Jul 22:05"), parse the notes
    and write the result to scheduled_at so items sort correctly.
    Safe to call multiple times — only updates rows where scheduled_at is NULL.
    """
    stops = session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()
    if not stops:
        raise HTTPException(status_code=404, detail=f"No stops found for trip {trip_id}")

    stop_ids = [s.id for s in stops]
    items = session.exec(
        select(ItineraryItem)
        .where(ItineraryItem.stop_id.in_(stop_ids))
        .where(ItineraryItem.scheduled_at == None)
        .where(ItineraryItem.notes != None)
        .where(ItineraryItem.notes != "")
    ).all()

    updated = 0
    for item in items:
        dt = _parse_date(item.notes)
        if dt:
            item.scheduled_at = dt
            session.add(item)
            updated += 1

    session.commit()
    return {"updated": updated}


@router.post("/import/enrich-accommodations/{trip_id}", status_code=200)
def enrich_accommodation_details(trip_id: int, session: Session = Depends(get_session)):
    """
    Look up missing accommodation details (address, phone, website) for all stops
    in the trip.

    Uses Google Places API if GOOGLE_PLACES_API_KEY env var is set (preferred —
    returns address, phone number, and website). Falls back to Nominatim
    (OpenStreetMap) which gives address and coordinates but no phone.

    Only fills gaps — values already present from the sheet are never overwritten.
    Safe to call multiple times; stops that already have an address are skipped.
    """
    try:
        result = enrich_accommodations(session, trip_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return result
