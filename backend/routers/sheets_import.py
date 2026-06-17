from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, SQLModel, select
from ..database import get_session
from ..sheets import fetch_sheets
from ..importer import import_sheets, import_flights, _parse_flights_sheet, _find_stop_for_flight, FLIGHT_SHEET_NAMES
from ..models import TripRead, Stop

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

    results = []
    for sheet_name, csv_text in sheets_raw.items():
        if sheet_name.lower() not in FLIGHT_SHEET_NAMES:
            continue
        for flight in _parse_flights_sheet(csv_text):
            depart_iso = flight["details"].get("depart_time", "") if flight["details"] else ""
            stop = _find_stop_for_flight(stops, flight["origin"], flight["stop_location"], depart_iso)
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
