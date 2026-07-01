"""Push notification triggers: flight check-in window opening, and a fixed
lead time before other-transport (rail/transfer) departure.

Idempotent via NotificationLog — running any number of times per real-world
event sends at most one notification per (item, kind).
"""
import re
from datetime import datetime, timedelta
from typing import Optional

from sqlmodel import Session, select

from .models import ItineraryItem, ItemKind, Stop, TripMembership, PushSubscription, NotificationLog
from .push import send_push, PushSendError

# How far before departure to alert for non-flight transport (rail/transfer).
# TODO: make configurable (per-item or per-user) — fixed default for now.
DEPARTURE_LEAD_HOURS = 3

# If a trigger time has already passed by more than this, skip it rather than
# firing a stale/misleading notification (e.g. after a cron outage).
GRACE_HOURS = 6


def _parse_checkin_window(s) -> Optional[float]:
    """Hours before departure that check-in opens. Mirrors frontend/src/checkin.js:parseCheckinWindow."""
    if not s:
        return None
    s = str(s).strip().lower()
    m = re.match(r"^(\d+(?:\.\d+)?)\s*d(?:ay)?s?$", s)
    if m:
        return float(m.group(1)) * 24
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(?:h(?:r|ours?)?)?$", s)
    if m and m.group(1):
        return float(m.group(1))
    return None


def _parse_dt(s) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s)[:16])
    except ValueError:
        return None


def _due_triggers(session: Session, now: datetime):
    """Yield (item, kind, depart) for items whose trigger has fired, isn't
    logged yet, and isn't too stale to still be useful."""
    items = session.exec(
        select(ItineraryItem).where(
            ItineraryItem.kind.in_([ItemKind.flight, ItemKind.rail, ItemKind.transfer])
        )
    ).all()
    logged = {(row.item_id, row.kind) for row in session.exec(select(NotificationLog)).all()}

    for item in items:
        d = item.details or {}
        depart = _parse_dt(d.get("depart_time"))
        if not depart or depart <= now:
            continue  # no depart time, or already departed

        if item.kind == ItemKind.flight:
            window_hours = _parse_checkin_window(d.get("checkin_window"))
            if window_hours is None:
                continue
            notify_at = depart - timedelta(hours=window_hours)
            kind = "checkin"
        else:
            notify_at = depart - timedelta(hours=DEPARTURE_LEAD_HOURS)
            kind = "departure"

        if (item.id, kind) in logged:
            continue
        if notify_at > now:
            continue  # not due yet
        if notify_at < now - timedelta(hours=GRACE_HOURS):
            continue  # too stale

        yield item, kind, depart


def _notification_payload(item: ItineraryItem, kind: str, depart: datetime) -> dict:
    name = item.name or item.kind.value
    if kind == "checkin":
        return {"title": "Check-in now open", "body": f"{name} — online check-in is open", "url": "/"}
    when = depart.strftime("%H:%M")
    return {"title": "Departure approaching", "body": f"{name} departs at {when}", "url": "/"}


def _recipients(session: Session, trip_id: int) -> list[PushSubscription]:
    members = session.exec(select(TripMembership).where(TripMembership.trip_id == trip_id)).all()
    emails = {m.user_email for m in members}
    if not emails:
        return []
    return session.exec(select(PushSubscription).where(PushSubscription.user_email.in_(emails))).all()


def send_due_notifications(session: Session, *, now: Optional[datetime] = None, sender=send_push) -> int:
    """Send every due (item, kind) trigger to all of that trip's subscribed
    devices, logging each so it's never sent twice. Returns triggers processed."""
    now = now or datetime.utcnow()
    processed = 0
    for item, kind, depart in list(_due_triggers(session, now)):
        stop = session.get(Stop, item.stop_id)
        if not stop:
            continue
        payload = _notification_payload(item, kind, depart)
        for sub in _recipients(session, stop.trip_id):
            info = {"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}
            try:
                sender(info, payload)
            except PushSendError as e:
                if e.expired:
                    session.delete(sub)
        session.add(NotificationLog(item_id=item.id, kind=kind))
        processed += 1
    session.commit()
    return processed
