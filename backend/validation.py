"""Date sanity checks — flag items whose date falls outside their stop's window.

Catches the residual class of bad data (typos, year mistakes, mis-filed items)
that survives even a clean import — e.g. an item dated 2025 sitting in a 2026 stop.
"""
from datetime import datetime
from sqlmodel import Session, select

from .models import Stop, ItineraryItem

_DATE_FORMATS = (
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
)


def _to_dt(v):
    if not v:
        return None
    if isinstance(v, datetime):
        return v
    s = str(v)[:19].replace(" ", "T") if "T" not in str(v) else str(v)[:19]
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _item_primary_dt(item: ItineraryItem):
    """The date that places an item on the timeline (mirrors StopCard's sortKey)."""
    d = item.details or {}
    if item.kind in ("flight", "rail"):
        return _to_dt(d.get("depart_time")) or _to_dt(item.scheduled_at)
    if item.kind == "accommodation":
        return _to_dt(d.get("bag_drop")) or _to_dt(d.get("checkin")) or _to_dt(item.scheduled_at)
    return _to_dt(item.scheduled_at)


def _item_span(item: ItineraryItem):
    """The (start, end) datetimes an item occupies. For most items this is a single
    point (start == end). Accommodations span check-in → check-out, so a hotel booked
    the night before arrival or checking out on departure day still overlaps its stop."""
    start = _item_primary_dt(item)
    if item.kind == "accommodation":
        end = _to_dt((item.details or {}).get("checkout")) or start
        return start, end
    return start, start


def date_warnings(session: Session, trip_id: int) -> list[dict]:
    """Items whose date sits before their stop's arrival or after its departure.
    Stops without dates are skipped.

    Items are compared as a span (start → end) against the window. For point items
    start == end; for accommodations the span is check-in → check-out, so a hotel
    booked the night before arrival or checking out on the departure day still
    overlaps its stop and is not flagged. Only stays that fall *entirely* outside
    the window are warned.

    The trip's final stop is exempt from "after departure" warnings — the journey
    home (connecting flights, transfers) legitimately departs after the last stop,
    and there's no later stop for those items to belong to."""
    stops = session.exec(select(Stop).where(Stop.trip_id == trip_id)).all()
    dated = [s for s in stops if s.arrive or s.depart]
    last_stop_id = max(dated, key=lambda s: s.depart or s.arrive).id if dated else None
    out: list[dict] = []
    for stop in stops:
        a = stop.arrive.date() if stop.arrive else None
        d = stop.depart.date() if stop.depart else None
        if not a and not d:
            continue
        items = session.exec(select(ItineraryItem).where(ItineraryItem.stop_id == stop.id)).all()
        for it in items:
            start, end = _item_span(it)
            if not start:
                continue
            start_day, end_day = start.date(), end.date()
            reason = None
            if a and end_day < a:
                reason = "before stop arrival"
            elif d and start_day > d and stop.id != last_stop_id:
                reason = "after stop departure"
            if reason:
                out.append({
                    "item_id": it.id,
                    "name": it.name,
                    "kind": it.kind,
                    "stop_location": stop.location,
                    "item_date": start.isoformat(),
                    "stop_arrive": stop.arrive.isoformat() if stop.arrive else None,
                    "stop_depart": stop.depart.isoformat() if stop.depart else None,
                    "reason": reason,
                })
    return out
