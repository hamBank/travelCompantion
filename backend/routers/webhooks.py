"""AeroDataBox flight-alert webhook receiver — plan 14.

AeroDataBox POSTs a FlightNotificationContract here whenever a subscribed
flight's data changes. Deliveries carry no signature header (spike-confirmed),
so the unguessable path secret IS the authentication — same
token-as-access-control pattern as /calendar/ and /shared/. A wrong or unset
secret 404s without touching the body.

Must answer 2xx within 10 seconds or AeroDataBox counts the delivery as
failed (and, with retries configured, would bill each retry) — the evaluation
below is a few dict reads and DB writes, well inside that budget, so no
background handoff is needed.
"""
import hmac

from fastapi import APIRouter, HTTPException, Request, Depends
from sqlmodel import Session, select

from ..database import get_session
from ..models import ItineraryItem, ItemKind
from .. import flight_alert_subscriptions
from ..notifications import evaluate_flight_alert

router = APIRouter()


def _item_for_subscription(session: Session, subscription_id: str):
    """The flight item holding this subscription id in its details. JSON
    details aren't queryable portably across sqlite/Postgres, so scan flight
    items in Python — single-user dataset, dozens of flights at most."""
    flights = session.exec(
        select(ItineraryItem).where(ItineraryItem.kind == ItemKind.flight)
    ).all()
    for item in flights:
        if (item.details or {}).get("alert_subscription_id") == subscription_id:
            return item
    return None


@router.post("/webhooks/aerodatabox/{secret}")
async def aerodatabox_webhook(secret: str, request: Request,
                              session: Session = Depends(get_session)):
    configured = flight_alert_subscriptions.WEBHOOK_SECRET
    if not configured or not hmac.compare_digest(secret, configured):
        raise HTTPException(status_code=404)

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    subscription_id = ((payload.get("subscription") or {}).get("id") or "")
    flights = payload.get("flights") or []
    if not subscription_id or not flights:
        return {"processed": 0}  # 2xx: nothing to do isn't a delivery failure

    item = _item_for_subscription(session, subscription_id)
    if item is None:
        # Unknown/stale subscription (item deleted between notification and
        # reconcile cleanup) — still 2xx so AeroDataBox doesn't retry-bill.
        return {"processed": 0}

    sent = 0
    for flight in flights:
        sent += evaluate_flight_alert(session, item, flight)
    return {"processed": len(flights), "alerts_sent": sent}
