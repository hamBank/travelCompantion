from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, SQLModel, select
from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role
from ..sheets import fetch_sheets
from ..importer import import_sheets, import_flights, update_stop_dates, enrich_accommodations, _parse_flights_sheet, _assign_flights_to_stops, _parse_date, FLIGHT_SHEET_NAMES
from ..models import TripRead, Stop, ItineraryItem, TripMembership, TripRole

router = APIRouter(tags=["import"])


class SheetsImportRequest(SQLModel):
    trip_name: str


class SheetsImportResult(TripRead):
    stops_imported: int


@router.post("/import/sheets", response_model=SheetsImportResult, status_code=201)
def import_from_sheets(req: SheetsImportRequest, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    try:
        sheets_raw = fetch_sheets()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    trip = import_sheets(session, req.trip_name, sheets_raw)

    stop_count = session.exec(
        select(Stop).where(Stop.trip_id == trip.id)
    ).all()
    data = trip.model_dump()  # capture before the membership commit expires attributes

    # Creator becomes the owner of the imported trip.
    session.add(TripMembership(trip_id=trip.id, user_email=user["email"].lower(), role=TripRole.owner))
    session.commit()

    return SheetsImportResult(**data, stops_imported=len(stop_count))


@router.post("/import/sheets/flights/{trip_id}", status_code=200)
def import_flights_only(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """
    Fetch the Flights sheet and attach flight items to an existing trip's stops.
    Does not create a new trip or touch existing stops/items.
    """
    require_trip_role(session, user, trip_id, TripRole.editor)
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
def update_stop_dates_from_sheets(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """
    Re-read arrive/depart dates from the location sheets and patch existing stops.
    Safe to call on a trip that already has manually-edited items — only dates change.
    """
    require_trip_role(session, user, trip_id, TripRole.editor)
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
def preview_flight_assignments(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """
    Dry-run: show which stop each flight would be assigned to, without importing.
    Useful for diagnosing stop-matching issues.
    """
    require_trip_role(session, user, trip_id, TripRole.viewer)
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
def backfill_scheduled_at(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """
    For existing activity items that have no scheduled_at but have a date string in
    their notes field (e.g. "24/7 12:00", "Wednesday 22 Jul 22:05"), parse the notes
    and write the result to scheduled_at so items sort correctly.
    Safe to call multiple times — only updates rows where scheduled_at is NULL.
    """
    require_trip_role(session, user, trip_id, TripRole.editor)
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
def enrich_accommodation_details(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """
    Look up missing accommodation details (address, phone, website) for all stops
    in the trip.

    Uses Google Places API if GOOGLE_PLACES_API_KEY env var is set (preferred —
    returns address, phone number, and website). Falls back to Nominatim
    (OpenStreetMap) which gives address and coordinates but no phone.

    Only fills gaps — values already present from the sheet are never overwritten.
    Safe to call multiple times; stops that already have an address are skipped.
    """
    require_trip_role(session, user, trip_id, TripRole.editor)
    try:
        result = enrich_accommodations(session, trip_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return result


@router.post("/import/backfill-accommodations/{trip_id}", status_code=200)
def backfill_accommodation_items(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    """
    For trips imported with older code, create ItineraryItem(kind=accommodation)
    rows from the Stop-level accommodation fields (stop.accommodation,
    stop.accommodation_link, stop.accommodation_notes, stop.check_in,
    stop.check_out) where no accommodation item already exists.

    Safe to call multiple times — skips stops that already have an item.
    After running this, call /import/enrich-accommodations/{trip_id} to fill
    in missing addresses and contact details.
    """
    require_trip_role(session, user, trip_id, TripRole.editor)
    from ..importer import ItemKind, ItemStatus, _combine_checkinout
    from ..models import ItineraryItem as Item

    stops = session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()
    if not stops:
        raise HTTPException(status_code=404, detail=f"No stops found for trip {trip_id}")

    created, skipped, detail = 0, 0, []
    for stop in stops:
        if not stop.accommodation:
            continue

        existing = session.exec(
            select(Item)
            .where(Item.stop_id == stop.id)
            .where(Item.kind == ItemKind.accommodation)
        ).first()

        if existing:
            skipped += 1
            detail.append({"stop": stop.location, "status": "skipped (item exists)"})
            continue

        details = {}
        if stop.accommodation_notes:
            details["description"] = stop.accommodation_notes
        if stop.check_in:
            ci = _combine_checkinout(stop.arrive, stop.check_in)
            if ci:
                details["checkin"] = ci
        if stop.check_out:
            co = _combine_checkinout(stop.depart, stop.check_out)
            if co:
                details["checkout"] = co

        session.add(Item(
            stop_id=stop.id,
            kind=ItemKind.accommodation,
            name=stop.accommodation,
            link=stop.accommodation_link or "",
            scheduled_at=stop.arrive,
            status=ItemStatus.pending,
            details=details or None,
        ))
        created += 1
        detail.append({"stop": stop.location, "name": stop.accommodation, "status": "created"})

    session.commit()
    return {"created": created, "skipped": skipped, "detail": detail}
