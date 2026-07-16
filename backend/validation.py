"""Date sanity checks for a trip: items whose date falls outside their stop's
window, uncovered accommodation nights, missing inter-stop transport, and
impossible (overlapping) transport connections.

Catches the residual class of bad data (typos, year mistakes, mis-filed items)
that survives even a clean import — e.g. an item dated 2025 sitting in a 2026 stop.

Design constraint for every check in this module: keep the false-positive rate
low. When a signal is ambiguous, don't warn — a noisy banner just trains the
user to stop reading it.
"""
from collections import defaultdict
from datetime import datetime, timedelta
from sqlmodel import Session, select
from sqlalchemy import nullslast, func

from . import tz_check
from .models import Stop, ItineraryItem

# Items that represent movement between places. Shared by the missing-transport
# and impossible-connection checks below.
_TRANSPORT_KINDS = ("flight", "rail", "transfer", "river_transfer", "cycling")

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
    point (start == end). Some items legitimately straddle a stop boundary:

      * accommodations span check-in → check-out, so a hotel booked the night before
        arrival or checking out on departure day still overlaps its stop;
      * transit (flight / rail / transfer) spans departure → arrival, so an overnight
        train arriving into a stop in the morning (it left the previous city the
        evening before) still overlaps the stop it arrives at.

    A span that overlaps the stop window at all is not flagged.

    `end` is None when an accommodation has no check-out: a lone check-in is an
    open-ended stay through the stop, not a zero-night one, so it must not be read
    as ending before arrival. A check-out earlier than the check-in is contradictory
    data (you cannot check out before you check in — usually a wrong stop departure
    date, from which check-out is derived) and is likewise treated as open-ended, so
    it never makes a stay look like it ended before the stop began."""
    start = _item_primary_dt(item)
    d = item.details or {}
    if item.kind == "accommodation":
        checkout = _to_dt(d.get("checkout"))
        if checkout and start and checkout < start:
            checkout = None
        return start, checkout
    if item.kind in ("flight", "rail", "transfer"):
        return start, _to_dt(d.get("arrive_time")) or start
    return start, start


def _transport_times(item: ItineraryItem):
    """(depart, arrive) datetimes for a transport item, used by the missing-transport
    and impossible-connection checks. Falls back to scheduled_at for the departure
    when a kind-specific depart_time isn't set (e.g. transfer/river_transfer, which
    aren't covered by `_item_primary_dt`'s flight/rail special-case)."""
    d = item.details or {}
    depart = _to_dt(d.get("depart_time")) or _to_dt(item.scheduled_at)
    arrive = _to_dt(d.get("arrive_time")) or depart
    return depart, arrive


def _ordered_stops(session: Session, trip_id: int):
    """Same ordering as GET /trips/{id}/stops, so 'consecutive stops' below matches
    what the user actually sees in the timeline."""
    return session.exec(
        select(Stop).where(Stop.trip_id == trip_id)
        .order_by(nullslast(func.date(Stop.arrive)), nullslast(func.date(Stop.depart)), Stop.sort_order)
    ).all()


def _uncovered_night_warnings(stop: Stop, items: list[ItineraryItem]) -> list[dict]:
    """Nights within [arrive, depart) not covered by any accommodation item's
    checkin→checkout span. One warning per contiguous gap, not per night.

    Gated so a same-day (or unbooked one-night) transit stop doesn't nag: we only
    look at stops with at least one real night (depart after arrive), and among
    those, only warn when there's either an accommodation item present (so the
    stop clearly did mean to have lodging — just check the gap) or the stop spans
    2+ nights (long enough that "no lodging at all" is itself worth a flag)."""
    if not stop.arrive or not stop.depart:
        return []
    arrive_day = stop.arrive.date()
    depart_day = stop.depart.date()
    nights_count = (depart_day - arrive_day).days
    if nights_count < 1:
        return []
    accommodations = [it for it in items if it.kind == "accommodation"]
    if not accommodations and nights_count < 2:
        return []

    covered = set()
    for acc in accommodations:
        d = acc.details or {}
        checkin = _to_dt(d.get("checkin"))
        if not checkin:
            continue
        checkout = _to_dt(d.get("checkout"))
        if checkout and checkout < checkin:
            checkout = None  # contradictory data — treat as open-ended, same as _item_span
        start_night = max(checkin.date(), arrive_day)
        end_night = min(checkout.date(), depart_day) if checkout else depart_day
        n = start_night
        while n < end_night:
            covered.add(n)
            n += timedelta(days=1)

    nights = [arrive_day + timedelta(days=i) for i in range(nights_count)]
    out = []
    gap_start = None
    for i, n in enumerate(nights):
        is_last = i == len(nights) - 1
        if n not in covered:
            if gap_start is None:
                gap_start = n
            if is_last:
                _emit_gap(out, stop, gap_start, n)
        else:
            if gap_start is not None:
                _emit_gap(out, stop, gap_start, nights[i - 1])
                gap_start = None
    return out


def _emit_gap(out: list[dict], stop: Stop, gap_start, gap_end):
    count = (gap_end - gap_start).days + 1
    out.append({
        "item_id": None,
        "name": "Uncovered accommodation",
        "kind": None,
        "stop_location": stop.location,
        "item_date": gap_start.isoformat(),
        "stop_arrive": stop.arrive.isoformat() if stop.arrive else None,
        "stop_depart": stop.depart.isoformat() if stop.depart else None,
        "reason": f"{count} night{'s' if count != 1 else ''} uncovered from {gap_start.isoformat()}",
    })


def _missing_transport_warnings(stops: list[Stop], items_by_stop: dict) -> list[dict]:
    """Consecutive stops with different locations where no transport item (in
    either stop) departs or arrives on/around the transition day. Skipped when
    either stop lacks any date at all — there's nothing to anchor "around" to."""
    out = []
    for s1, s2 in zip(stops, stops[1:]):
        if not s1.location or not s2.location or s1.location == s2.location:
            continue
        s1_day = s1.depart.date() if s1.depart else (s1.arrive.date() if s1.arrive else None)
        s2_day = s2.arrive.date() if s2.arrive else (s2.depart.date() if s2.depart else None)
        if s1_day is None or s2_day is None:
            continue

        window = set()
        for day in (s1_day, s2_day):
            for delta in (-1, 0, 1):
                window.add(day + timedelta(days=delta))

        candidates = items_by_stop.get(s1.id, []) + items_by_stop.get(s2.id, [])
        found = False
        for it in candidates:
            if it.kind not in _TRANSPORT_KINDS:
                continue
            depart, arrive = _transport_times(it)
            if (depart and depart.date() in window) or (arrive and arrive.date() in window):
                found = True
                break
        if not found:
            out.append({
                "item_id": None,
                "name": "Missing transport",
                "kind": None,
                "stop_location": f"{s1.location} → {s2.location}",
                "item_date": s1_day.isoformat(),
                "stop_arrive": s2.arrive.isoformat() if s2.arrive else None,
                "stop_depart": s1.depart.isoformat() if s1.depart else None,
                "reason": f"No transport found between {s1.location} and {s2.location} around {s1_day.isoformat()}",
            })
    return out


def _impossible_connection_warnings(all_items: list[tuple]) -> list[dict]:
    """Two transport items, adjacent in departure order, where the later one departs
    before the earlier one arrives. Same-stop pairs share a timezone by construction,
    so any overlap at all is flagged; cross-stop pairs only warn past a 6h cushion,
    since we don't attempt precise cross-timezone math here (see CLAUDE.md)."""
    transports = []
    for stop, it in all_items:
        if it.kind not in _TRANSPORT_KINDS:
            continue
        depart, arrive = _transport_times(it)
        if not depart:
            continue
        transports.append((depart, arrive, stop, it))
    transports.sort(key=lambda t: t[0])

    out = []
    for (d1, a1, s1, it1), (d2, a2, s2, it2) in zip(transports, transports[1:]):
        if not a1:
            continue
        overlap = a1 - d2
        if overlap.total_seconds() <= 0:
            continue
        same_stop = s1.id is not None and s1.id == s2.id
        if not same_stop and overlap < timedelta(hours=6):
            continue
        out.append({
            "item_id": it2.id,
            "name": it2.name,
            "kind": it2.kind,
            "stop_location": s2.location,
            "item_date": d2.isoformat(),
            "stop_arrive": None,
            "stop_depart": None,
            "reason": f"departs before \"{it1.name}\" arrives",
        })
    return out


_TZ_MISMATCH_TOLERANCE_MIN = 30


def _flight_tz_mismatch(session: Session, it: ItineraryItem) -> list[dict]:
    """Compare a flight's stored depart_tz/arrive_tz against the real,
    DST-aware offset for its origin/destination airport — but ONLY when that
    airport's timezone is already cached (see backend/tz_check.py). Resolution
    happens exclusively in scripts/refresh_location_timezones.py's background
    cron; an uncached airport means "nothing to compare against yet", not a
    warning, so a fresh location never false-alarms before its first refresh."""
    d = it.details or {}
    out = []
    for leg, loc_key, tz_key, time_key in (
        ("Departure", "origin", "depart_tz", "depart_time"),
        ("Arrival", "destination", "arrive_tz", "arrive_time"),
    ):
        loc = d.get(loc_key)
        dt = _to_dt(d.get(time_key))
        if not loc or not dt:
            continue
        zone = tz_check.get_cached_zone(session, loc)
        if not zone:
            continue
        expected = tz_check.expected_offset_minutes(zone, dt.date())
        if expected is None:
            continue
        stored = tz_check.parse_stored_offset_minutes(d.get(tz_key), dt.date())
        if stored is not None and abs(stored - expected) <= _TZ_MISMATCH_TOLERANCE_MIN:
            continue
        exp_str = f"UTC{expected // 60:+d}" if expected % 60 == 0 else f"UTC{expected / 60:+.1f}"
        reason = (
            f"{leg} timezone not set for {loc} — expected {exp_str} ({zone})" if stored is None else
            f"{leg} timezone {d.get(tz_key)} doesn't match {loc}'s real offset {exp_str} ({zone})"
        )
        out.append({
            "item_id": it.id,
            "name": it.name,
            "kind": it.kind,
            "stop_location": loc,
            "item_date": dt.isoformat(),
            "stop_arrive": None,
            "stop_depart": None,
            "reason": reason,
        })
    return out


def _timezone_mismatch_warnings(session: Session, all_items: list[ItineraryItem]) -> list[dict]:
    """Flight-only for now — the one kind with reliable IATA origin/destination
    codes and dedicated depart_tz/arrive_tz fields (see backend/tz_check.py)."""
    out = []
    for it in all_items:
        if it.kind == "flight":
            out.extend(_flight_tz_mismatch(session, it))
    return out


def date_warnings(session: Session, trip_id: int) -> list[dict]:
    """Items whose date sits before their stop's arrival or after its departure.
    Stops without dates are skipped.

    Items are compared as a span (start → end) against the window. For point items
    start == end; for accommodations the span is check-in → check-out, so a hotel
    booked the night before arrival or checking out on the departure day still
    overlaps its stop and is not flagged. Only stays that fall *entirely* outside
    the window are warned. An accommodation with no check-out is open-ended, so it
    is never flagged as ending before arrival.

    The trip's final stop is exempt from "after departure" warnings — the journey
    home (connecting flights, transfers) legitimately departs after the last stop,
    and there's no later stop for those items to belong to.

    Beyond the per-item range check, this also flags trip-level coverage/conflict
    issues: uncovered accommodation nights, missing inter-stop transport, and
    impossible (overlapping) transport connections. `item_id` is null for the
    gap-style warnings (uncovered nights, missing transport) since they aren't
    about one specific item."""
    stops = _ordered_stops(session, trip_id)
    dated = [s for s in stops if s.arrive or s.depart]
    last_stop_id = max(dated, key=lambda s: s.depart or s.arrive).id if dated else None

    items_by_stop: dict = defaultdict(list)
    if stops:
        all_items = session.exec(
            select(ItineraryItem).where(ItineraryItem.stop_id.in_([s.id for s in stops]))
        ).all()
        for it in all_items:
            items_by_stop[it.stop_id].append(it)
    else:
        all_items = []

    out: list[dict] = []

    for stop in stops:
        a = stop.arrive.date() if stop.arrive else None
        d = stop.depart.date() if stop.depart else None
        if not a and not d:
            continue
        items = items_by_stop.get(stop.id, [])
        for it in items:
            start, end = _item_span(it)
            if not start:
                continue
            start_day = start.date()
            end_day = end.date() if end else None
            reason = None
            if a and end_day is not None and end_day < a:
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

    for stop in stops:
        out.extend(_uncovered_night_warnings(stop, items_by_stop.get(stop.id, [])))

    out.extend(_missing_transport_warnings(stops, items_by_stop))

    stop_by_id = {s.id: s for s in stops}
    all_items_with_stop = [(stop_by_id[it.stop_id], it) for it in all_items if it.stop_id in stop_by_id]
    out.extend(_impossible_connection_warnings(all_items_with_stop))

    out.extend(_timezone_mismatch_warnings(session, all_items))

    return out
