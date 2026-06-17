from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, SQLModel, select
from ..database import get_session
from ..sheets import fetch_sheets
from ..importer import import_sheets
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
