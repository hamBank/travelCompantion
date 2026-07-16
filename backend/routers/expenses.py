"""Actual, real-world logged spend (issue #59) — trip-wide, editor+ to write.

Distinct from ItineraryItem.cost/details.amount_paid (a *planned* item's
expected cost + how much has been paid) — an Expense is a point-in-time
"I spent X just now" event, optionally linked to a stop and/or an existing
item, but plenty of real spend has neither. See the Expense docstring in
models.py for the full rationale, including why deleting a stop/item only
unlinks an expense rather than deleting it.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..database import get_session
from ..auth import get_current_user
from ..permissions import require_trip_role
from ..models import Expense, ExpenseCreate, ExpenseRead, ExpenseUpdate, Stop, ItineraryItem, TripRole

router = APIRouter()


def _validate_links(session: Session, trip_id: int, stop_id: Optional[int], item_id: Optional[int]) -> None:
    """A linked stop/item must actually belong to this trip — otherwise an
    expense could be pinned to another trip's data (or a nonexistent row)."""
    if stop_id is not None:
        stop = session.get(Stop, stop_id)
        if not stop or stop.trip_id != trip_id:
            raise HTTPException(status_code=400, detail="Stop not found on this trip")
    if item_id is not None:
        item = session.get(ItineraryItem, item_id)
        if not item:
            raise HTTPException(status_code=400, detail="Item not found on this trip")
        item_stop = session.get(Stop, item.stop_id)
        if not item_stop or item_stop.trip_id != trip_id:
            raise HTTPException(status_code=400, detail="Item not found on this trip")


@router.get("/trips/{trip_id}/expenses", response_model=List[ExpenseRead])
def list_expenses(trip_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    require_trip_role(session, user, trip_id, TripRole.viewer)
    expenses = session.exec(select(Expense).where(Expense.trip_id == trip_id)).all()
    expenses.sort(key=lambda e: (e.occurred_at, e.id or 0))
    return [ExpenseRead(**e.model_dump()) for e in expenses]


@router.post("/trips/{trip_id}/expenses", response_model=ExpenseRead, status_code=201)
def create_expense(
    trip_id: int, body: ExpenseCreate,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    require_trip_role(session, user, trip_id, TripRole.editor)
    _validate_links(session, trip_id, body.stop_id, body.item_id)
    expense = Expense(trip_id=trip_id, **body.model_dump())
    session.add(expense)
    session.commit()
    session.refresh(expense)
    return ExpenseRead(**expense.model_dump())


def _get_writable_expense(session: Session, user: dict, expense_id: int) -> Expense:
    expense = session.get(Expense, expense_id)
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    require_trip_role(session, user, expense.trip_id, TripRole.editor)
    return expense


@router.patch("/expenses/{expense_id}", response_model=ExpenseRead)
def update_expense(
    expense_id: int, body: ExpenseUpdate,
    session: Session = Depends(get_session), user: dict = Depends(get_current_user),
):
    expense = _get_writable_expense(session, user, expense_id)
    data = body.model_dump(exclude_unset=True)

    new_stop_id = data.get("stop_id", expense.stop_id)
    new_item_id = data.get("item_id", expense.item_id)
    if "stop_id" in data or "item_id" in data:
        _validate_links(session, expense.trip_id, new_stop_id, new_item_id)

    for field, value in data.items():
        setattr(expense, field, value)

    session.add(expense)
    session.commit()
    session.refresh(expense)
    return ExpenseRead(**expense.model_dump())


@router.delete("/expenses/{expense_id}", status_code=204)
def delete_expense(expense_id: int, session: Session = Depends(get_session), user: dict = Depends(get_current_user)):
    expense = _get_writable_expense(session, user, expense_id)
    session.delete(expense)
    session.commit()
