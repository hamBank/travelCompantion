"""Push notification triggers: flight check-in window opening, and a fixed
lead time before other-transport (rail/transfer) departure.

Idempotent via NotificationLog — running any number of times per real-world
event sends at most one notification per (item, kind).
"""
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from . import flight_live
from .models import ItineraryItem, ItemKind, Stop, TripMembership, PushSubscription, NotificationLog
from .push import send_push, PushSendError
from .tzutil import approx_utc_offset_hours

# How far before departure to alert for non-flight transport (rail/transfer).
# TODO: make configurable (per-item or per-user) — fixed default for now.
DEPARTURE_LEAD_HOURS = 3

# How long before check-in actually opens to send a "get ready" heads-up. Some
# airlines assign seats in check-in order, so arriving even a few minutes late
# can mean picking from whatever's left — better to alert too early than to
# only confirm after the fact that the window has already been open a while.
CHECKIN_HEADS_UP_MINUTES = 20

# If a trigger time has already passed by more than this, skip it rather than
# firing a stale/misleading notification (e.g. after a cron outage).
GRACE_HOURS = 6

# ── Live flight delay/cancellation/gate-change alerts ─────────────────────────
# Only poll flights departing within this many hours (AeroDataBox's free tier
# is 600 units/month — this keeps the ceiling to roughly WINDOW/POLL_MINUTES*60
# calls per tracked flight, e.g. 24h/45min ≈ 32).
FLIGHT_ALERT_WINDOW_HOURS = float(os.getenv("FLIGHT_ALERT_WINDOW_HOURS", "24"))
# Minimum gap between polls of the same flight.
FLIGHT_ALERT_POLL_MINUTES = float(os.getenv("FLIGHT_ALERT_POLL_MINUTES", "45"))
# Delay-alert escalation thresholds (minutes). Only the largest bucket the
# current delay clears is sent, so a steady 45m delay doesn't re-alert every
# poll, but a growing delay (45m → 70m) still gets a fresh, more urgent alert.
DELAY_BUCKETS_MIN = [15, 30, 60, 120, 240]


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


def _local_to_utc(dt_str, tz, fallback_offset_hours: Optional[float] = None) -> Optional[datetime]:
    """Convert a stored local wall-clock datetime + timezone to a naive UTC
    datetime (naive throughout, matching this module's naive-UTC `now` convention).

    Mirrors frontend/src/components/StopCard.jsx:toUtcMs exactly — same fixed-
    offset ("GMT+8", "+08:00") and IANA zone name ("Europe/Helsinki") parsing —
    so the notification trigger and the UI agree on when things actually happen.

    When tz is absent or can't be resolved, `fallback_offset_hours` (from the
    item's stop — see _stop_utc_offset_hours) is applied instead; with neither,
    the datetime is treated as already-UTC (the frontend's fallback, tolerable
    there because its uses are relative/cushioned, but wrong by the full
    destination offset here where triggers compare against real UTC now — on a
    UTC+8 trip that fires "departure approaching" hours after the train left).
    """
    if not dt_str:
        return None
    base = str(dt_str)
    if "T" not in base:
        base += "T00:00"
    try:
        naive = datetime.fromisoformat(base[:16])
    except ValueError:
        return None
    if not tz:
        if fallback_offset_hours is not None:
            return naive - timedelta(hours=fallback_offset_hours)
        return naive

    tz_s = str(tz).strip()
    m = re.match(r"^(?:GMT|UTC)?\s*([+-]?)(\d{1,2})(?::?(\d{2}))?$", tz_s, re.IGNORECASE)
    if m and (m.group(1) or m.group(3) is not None or m.group(2)):
        sign = -1 if m.group(1) == "-" else 1
        off_min = sign * (int(m.group(2)) * 60 + int(m.group(3) or 0))
        return naive - timedelta(minutes=off_min)

    try:
        aware_local = naive.replace(tzinfo=ZoneInfo(tz_s))
        return aware_local.astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        if fallback_offset_hours is not None:
            return naive - timedelta(hours=fallback_offset_hours)
        return naive


def _stop_utc_offset_hours(session: Session, item: ItineraryItem) -> Optional[float]:
    """Best-effort UTC offset for an item's stop, used when the item's own
    details carry no depart_tz (manually-entered rail/transfer items usually
    don't). Two sources, most-trustworthy first:

    - the stop's `timezone` column (sheet-import supplies a real per-stop
      offset). Its model default is "0", which is indistinguishable from
      "never set" — so 0 falls through rather than being trusted; a genuinely
      UTC stop is recovered by the longitude path landing on ~0 anyway.
    - the stop's longitude, approximated at 15°/hour (backend/tzutil.py) —
      within an hour or two everywhere, plenty for triggers with a 3-hour
      lead and a 6-hour grace window.
    """
    stop = session.get(Stop, item.stop_id)
    if not stop:
        return None
    try:
        off = float(str(stop.timezone or "").strip())
        if off != 0:
            return off
    except ValueError:
        pass
    try:
        lng = float(str(stop.lng).split(",")[0].strip())
    except (ValueError, TypeError):
        return None
    if not (-180 <= lng <= 180):
        return None
    return float(approx_utc_offset_hours(lng))


def _due_triggers(session: Session, now: datetime):
    """Yield (item, kind, depart) for items whose trigger has fired, isn't
    logged yet, and isn't too stale to still be useful."""
    items = session.exec(
        select(ItineraryItem).where(
            ItineraryItem.kind.in_([ItemKind.flight, ItemKind.rail, ItemKind.transfer, ItemKind.river_transfer])
        )
    ).all()
    logged = {(row.item_id, row.kind) for row in session.exec(select(NotificationLog)).all()}

    for item in items:
        d = item.details or {}
        depart_local = d.get("depart_time")
        fallback = None if d.get("depart_tz") else _stop_utc_offset_hours(session, item)
        depart = _local_to_utc(depart_local, d.get("depart_tz"), fallback_offset_hours=fallback)
        if not depart or depart <= now:
            continue  # no depart time, or already departed (both in UTC)

        if item.kind == ItemKind.flight:
            window_hours = _parse_checkin_window(d.get("checkin_window"))
            if window_hours is None:
                continue
            checkin_opens_at = depart - timedelta(hours=window_hours)
            candidates = [
                ("checkin_heads_up", checkin_opens_at - timedelta(minutes=CHECKIN_HEADS_UP_MINUTES)),
                ("checkin", checkin_opens_at),
            ]
        else:
            candidates = [("departure", depart - timedelta(hours=DEPARTURE_LEAD_HOURS))]

        for kind, notify_at in candidates:
            if (item.id, kind) in logged:
                continue
            if notify_at > now:
                continue  # not due yet
            if notify_at < now - timedelta(hours=GRACE_HOURS):
                continue  # too stale

            yield item, kind, depart_local


def _notification_payload(item: ItineraryItem, kind: str, depart_local: str) -> dict:
    """depart_local is the flight/train's own local departure time string
    (e.g. "2026-07-02T14:35") — shown as-is so the notification reads in the
    same local time the traveller sees in the app, not a UTC-shifted one."""
    d = item.details or {}
    name = item.name or item.kind.value
    when = str(depart_local)[11:16] if len(str(depart_local)) >= 16 else str(depart_local)
    # Same field-name fallbacks used by the frontend (StopCard.jsx) so the
    # notification and the in-app card agree on what "the flight/train number"
    # and "the destination" are for each item kind.
    number = d.get("flight_number") or d.get("train_number") or ""
    destination = d.get("destination") or d.get("end_location") or ""

    label = f"{name} ({number})" if number else name
    route = f" to {destination}" if destination else ""

    if kind == "checkin_heads_up":
        body = f"{label}{route} at {when} — check-in opens in {CHECKIN_HEADS_UP_MINUTES} min, be ready to grab a good seat"
        return {"title": "Check-in opening soon", "body": body, "url": "/", "urgent": True}

    if kind == "checkin":
        body = f"{label}{route} at {when} — online check-in is open"
        return {"title": "Check-in now open", "body": body, "url": "/", "urgent": True}

    body = f"{label}{route} departs at {when}"
    return {"title": "Departure approaching", "body": body, "url": "/", "urgent": True}


def _recipients(session: Session, trip_id: int) -> list[PushSubscription]:
    members = session.exec(select(TripMembership).where(TripMembership.trip_id == trip_id)).all()
    emails = {m.user_email for m in members}
    if not emails:
        return []
    return session.exec(select(PushSubscription).where(PushSubscription.user_email.in_(emails))).all()


def send_due_notifications(session: Session, *, now: Optional[datetime] = None, sender=send_push) -> int:
    """Send every due (item, kind) trigger to all of that trip's subscribed
    devices, logging each so it's never sent twice. Returns triggers processed."""
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    processed = 0
    for item, kind, depart in list(_due_triggers(session, now)):
        stop = session.get(Stop, item.stop_id)
        if not stop:
            continue
        payload = _notification_payload(item, kind, depart)
        for sub in _recipients(session, stop.trip_id):
            info = {"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}
            try:
                sender(info, payload, urgent=True)
            except PushSendError as e:
                if e.expired:
                    session.delete(sub)
        session.add(NotificationLog(item_id=item.id, kind=kind))
        processed += 1
    session.commit()
    return processed


def _flight_label(details: dict, item: ItineraryItem) -> str:
    number = details.get("flight_number") or ""
    origin = details.get("origin") or ""
    destination = details.get("destination") or ""
    route = f"{origin}→{destination}" if origin and destination else (destination or origin)
    label = f"{number} {route}".strip()
    return label or item.name or "Flight"


def send_flight_alerts(session: Session, *, now: Optional[datetime] = None,
                       sender=send_push, fetch=None) -> int:
    """Poll near-departure flights for live status and push an alert on
    cancellation, a delay-bucket escalation, or a gate change. Idempotent via
    NotificationLog like send_due_notifications — kinds are "flight_cancel",
    "flight_delay:{bucket}", and "flight_gate:{gate}". Returns alerts sent.

    `fetch` defaults to flight_live.fetch_flight; injectable for tests.
    """
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    fetch = fetch or flight_live.fetch_flight
    window = timedelta(hours=FLIGHT_ALERT_WINDOW_HOURS)
    poll_gap = timedelta(minutes=FLIGHT_ALERT_POLL_MINUTES)

    flights = session.exec(
        select(ItineraryItem).where(ItineraryItem.kind == ItemKind.flight)
    ).all()
    logged = {(row.item_id, row.kind) for row in session.exec(select(NotificationLog)).all()}

    sent = 0
    for item in flights:
        d = item.details or {}
        flight_iata = (d.get("flight_number") or "").replace(" ", "").upper()
        depart_local = d.get("depart_time")
        if not flight_iata or not depart_local:
            continue

        fallback = None if d.get("depart_tz") else _stop_utc_offset_hours(session, item)
        depart = _local_to_utc(depart_local, d.get("depart_tz"), fallback_offset_hours=fallback)
        if not depart or not (now < depart <= now + window):
            continue  # no depart time, already departed, or outside the alert window

        last_poll_s = d.get("flight_poll_at")
        if last_poll_s:
            try:
                if now - datetime.fromisoformat(last_poll_s) < poll_gap:
                    continue  # polled recently enough
            except ValueError:
                pass  # malformed stored value — treat as never polled

        # Record the poll attempt before calling out, so a failing lookup is
        # still throttled (an outage shouldn't retry every cron tick).
        d = {**d, "flight_poll_at": now.isoformat(timespec="minutes")}
        item.details = d
        session.add(item)
        session.commit()

        try:
            live = fetch(flight_iata, str(depart_local)[:10])
        except flight_live.FlightLiveError:
            continue  # one flight's failure shouldn't stop the run
        if live is None:
            continue

        stop = session.get(Stop, item.stop_id)
        if not stop:
            continue
        recipients = _recipients(session, stop.trip_id)
        label = _flight_label(d, item)

        def _send(kind: str, title: str, body: str) -> None:
            nonlocal sent
            if (item.id, kind) in logged:
                return
            payload = {"title": title, "body": body, "url": "/", "urgent": True}
            for sub in recipients:
                info = {"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}}
                try:
                    sender(info, payload, urgent=True)
                except PushSendError as e:
                    if e.expired:
                        session.delete(sub)
            session.add(NotificationLog(item_id=item.id, kind=kind))
            logged.add((item.id, kind))
            sent += 1

        status = live.get("status")
        dep_movement = live.get("departure") or {}

        if status in ("Canceled", "CanceledUncertain"):
            _send("flight_cancel", "Flight cancelled", f"{label} has been cancelled")
        else:
            dep_delay = flight_live.delay_min(dep_movement)
            if dep_delay is not None:
                applicable = [b for b in DELAY_BUCKETS_MIN if b <= dep_delay]
                if applicable:
                    bucket = max(applicable)
                    revised_local = (dep_movement.get("revisedTime") or {}).get("local")
                    when = revised_local[11:16] if revised_local else "?"
                    _send(
                        f"flight_delay:{bucket}", "Flight delayed",
                        f"{label} now departing {when} ({flight_live.delay_str(dep_delay)})",
                    )

            live_gate = dep_movement.get("gate")
            stored_gate = d.get("origin_gate")
            if live_gate and stored_gate and str(live_gate) != str(stored_gate):
                _send(
                    f"flight_gate:{live_gate}", "Gate changed",
                    f"Gate changed: {stored_gate} → {live_gate}",
                )

        session.commit()

    return sent
