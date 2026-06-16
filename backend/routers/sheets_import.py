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
    """
    Fetch all sheets from Google Sheets and seed a new Trip in the database.
    Opens a browser on first run for OAuth authentication.
    If ~/.travel_companion_token.json already exists (from the desktop app) it is reused.
    """
    try:
        sheets_raw = fetch_sheets()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    trip = import_sheets(session, req.trip_name, sheets_raw)

    stop_count = session.exec(
        select(Stop).where(Stop.trip_id == trip.id)
    ).all()

    return SheetsImportResult(**trip.model_dump(), stops_imported=len(stop_count))
