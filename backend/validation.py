"""Date sanity checks for a trip: items whose date falls outside their stop's
window, uncovered accommodation nights, missing inter-stop transport,
impossible (overlapping) transport connections, timezone mismatches, and
stops missing a country.

Catches the residual class of bad data (typos, year mistakes, mis-filed items)
that survives even a clean import — e.g. an item dated 2025 sitting in a 2026 stop.

Design constraint for every check in this module: keep the false-positive rate
low. When a signal is ambiguous, don't warn — a noisy banner just trains the
user to stop reading it.
"""
import calendar
from collections import defaultdict
from datetime import date as _date, datetime, timedelta, timezone
from typing import Optional
from sqlmodel import Session, select
from sqlalchemy import nullslast, func

from . import tz_check
from .models import Stop, ItineraryItem, Trip, Traveler

# D8 (docs/plans/plan-17-travelers.md): the common "must be valid N months
# beyond travel" passport entry rule. A constant, not configurable per trip —
# see plan-17a-traveler-model-api.md.
PASSPORT_VALIDITY_MONTHS = 6

# Items that represent movement between places. Shared by the missing-transport
# and impossible-connection checks below.
_TRANSPORT_KINDS = ("flight", "rail", "transfer", "river_transfer", "cycling")

_DATE_FORMATS = (
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d",
)


def _today():
    """Real UTC calendar day — same reasoning as weather.py's utc_today
    (never the process's local tz, never date.today()). Exists as its own
    function (rather than inlining datetime.now(...).date()) purely so
    tests can monkeypatch it to a fixed date, matching that module's
    testability pattern."""
    return datetime.now(timezone.utc).date()


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


def _uncovered_night_warnings(stop: Stop, items: list[ItineraryItem], today) -> list[dict]:
    """Nights within [arrive, depart) not covered by any accommodation item's
    checkin→checkout span. One warning per contiguous gap, not per night.

    Gated so a same-day (or unbooked one-night) transit stop doesn't nag: we only
    look at stops with at least one real night (depart after arrive), and among
    those, only warn when there's either an accommodation item present (so the
    stop clearly did mean to have lodging — just check the gap) or the stop spans
    2+ nights (long enough that "no lodging at all" is itself worth a flag).

    A night that's already passed isn't actionable — there's nothing left to
    book — so the window is clipped to start at `today` (a gap straddling
    today only reports its still-future remainder; a gap entirely in the
    past disappears)."""
    if not stop.arrive or not stop.depart:
        return []
    arrive_day = max(stop.arrive.date(), today)
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


def _missing_transport_warnings(stops: list[Stop], items_by_stop: dict, today) -> list[dict]:
    """Consecutive stops with different locations where no transport item (in
    either stop) departs or arrives on/around the transition day. Skipped when
    either stop lacks any date at all — there's nothing to anchor "around" to.

    Also skipped once the transition day itself is already past — nothing
    left to book for a journey that (per the stored dates) already happened."""
    out = []
    for s1, s2 in zip(stops, stops[1:]):
        if not s1.location or not s2.location or s1.location == s2.location:
            continue
        s1_day = s1.depart.date() if s1.depart else (s1.arrive.date() if s1.arrive else None)
        s2_day = s2.arrive.date() if s2.arrive else (s2.depart.date() if s2.depart else None)
        if s1_day is None or s2_day is None:
            continue
        if max(s1_day, s2_day) < today:
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
        exp_str = _fmt_offset(expected)
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


def _fmt_offset(minutes: int) -> str:
    return f"UTC{minutes // 60:+d}" if minutes % 60 == 0 else f"UTC{minutes / 60:+.1f}"


def _stop_tz_mismatch(session: Session, stop: Stop) -> list[dict]:
    """Compare Stop.timezone (sheet-import's per-stop offset — see
    backend/tz_check.py:parse_stop_offset_minutes for its "2"/"-5" convention)
    against the location's real, DST-aware offset. Unlike flights, an UNSET
    stop timezone is never flagged: "0" is the model default for every
    manually-created stop (sheet import is the only writer), so treating it as
    "missing" would warn on nearly every stop in the app — only a genuinely
    *present-but-wrong* value is worth surfacing."""
    if not stop.location:
        return []
    stored = tz_check.parse_stop_offset_minutes(stop.timezone)
    if stored is None or stored == 0:
        return []
    on_date = stop.arrive or stop.depart
    if not on_date:
        return []
    zone = tz_check.get_cached_zone(session, stop.location)
    if not zone:
        return []
    expected = tz_check.expected_offset_minutes(zone, on_date.date())
    if expected is None or abs(stored - expected) <= _TZ_MISMATCH_TOLERANCE_MIN:
        return []
    # Suggested value in Stop.timezone's own plain-hours convention ("2",
    # "5.5") so the UI's one-click fix can PATCH it back verbatim.
    suggested = f"{expected // 60}" if expected % 60 == 0 else f"{expected / 60}"
    return [{
        "item_id": None,
        "name": "Timezone mismatch",
        "kind": None,
        "stop_location": stop.location,
        "item_date": on_date.date().isoformat(),
        "stop_arrive": stop.arrive.isoformat() if stop.arrive else None,
        "stop_depart": stop.depart.isoformat() if stop.depart else None,
        "reason": f"Stop timezone {stop.timezone} doesn't match {stop.location}'s real offset {_fmt_offset(expected)} ({zone})",
        "stop_id": stop.id,
        "suggested_timezone": suggested,
    }]


def _missing_country_warnings(session: Session, stops: list[Stop]) -> list[dict]:
    """A stop with no country recorded (a sheet-import gap, or a quick-added
    stop that skipped it) is genuinely incomplete data — unlike an unset
    Stop.timezone ("0" is the model default, indistinguishable from "never
    set", so _stop_tz_mismatch never flags it alone), a blank country has no
    ambiguous default and is always worth a warning.

    Only fires once the location has actually been resolved by
    scripts/refresh_location_timezones.py (both `iana_zone` and `country`
    cached) — an unresolved location isn't "missing" data, it just hasn't
    been looked up yet, same reasoning as _stop_tz_mismatch. The suggested
    fix bundles both the resolved country AND a DST-aware timezone for the
    stop's actual arrival date (not just today's offset) in one PATCH, so
    accepting it never leaves the stop with a correct country but a
    still-wrong timezone or vice versa."""
    out = []
    for stop in stops:
        if not stop.location or stop.country:
            continue
        if not stop.arrive:
            continue
        zone = tz_check.get_cached_zone(session, stop.location)
        country = tz_check.get_cached_country(session, stop.location)
        if not zone or not country:
            continue
        expected = tz_check.expected_offset_minutes(zone, stop.arrive.date())
        if expected is None:
            continue
        suggested_tz = f"{expected // 60}" if expected % 60 == 0 else f"{expected / 60}"
        out.append({
            "item_id": None,
            "name": "Missing country",
            "kind": None,
            "stop_location": stop.location,
            "item_date": stop.arrive.date().isoformat(),
            "stop_arrive": stop.arrive.isoformat() if stop.arrive else None,
            "stop_depart": stop.depart.isoformat() if stop.depart else None,
            "reason": f"No country set — {stop.location} is in {country} ({_fmt_offset(expected)} on arrival, {zone})",
            "stop_id": stop.id,
            "suggested_country": country,
            "suggested_timezone": suggested_tz,
        })
    return out


def _timezone_mismatch_warnings(session: Session, all_items: list[ItineraryItem], stops: list[Stop]) -> list[dict]:
    """Flight-only for item-level checks so far — the one kind with reliable
    IATA origin/destination codes and dedicated depart_tz/arrive_tz fields
    (see backend/tz_check.py). Stop-level checks cover Stop.timezone itself."""
    out = []
    for it in all_items:
        if it.kind == "flight":
            out.extend(_flight_tz_mismatch(session, it))
    for stop in stops:
        out.extend(_stop_tz_mismatch(session, stop))
    return out


def _trip_last_day(trip: Trip, stops: list[Stop], all_items: list[ItineraryItem]) -> Optional[_date]:
    """The latest date anywhere in the trip: `Trip.end_date`, every stop's
    arrive/depart, and every item's span end (falling back to its primary
    date) — the same "how far out does this trip run" range the rest of
    this module already reasons about (e.g. the uncovered-nights/missing-
    transport checks' stop dates), just widened to also cover the trip's own
    end_date and item dates so an undated final stop with only dated items,
    or a trip whose `end_date` runs later than any stop, doesn't understate
    the range. Used by the passport_expiry warning (D8)."""
    candidates: list[_date] = []
    if trip.end_date:
        candidates.append(trip.end_date.date())
    for s in stops:
        if s.arrive:
            candidates.append(s.arrive.date())
        if s.depart:
            candidates.append(s.depart.date())
    for it in all_items:
        start, end = _item_span(it)
        d = end or start
        if d:
            candidates.append(d.date())
    return max(candidates) if candidates else None


def _trip_first_day(trip: Trip, stops: list[Stop], all_items: list[ItineraryItem]) -> Optional[_date]:
    """The earliest date anywhere in the trip — the mirror image of
    `_trip_last_day` above (same widened range rule: `Trip.start_date`,
    every stop's arrive/depart, and every item's span start, falling back to
    its primary date), so an undated first stop with only dated items, or a
    trip whose `start_date` runs earlier than any stop, doesn't understate
    the range. Used by plan-17b's personal `days` total (trip span,
    first day -> last day inclusive) — the one range definition this module
    settled on; don't add a second one elsewhere."""
    candidates: list[_date] = []
    if trip.start_date:
        candidates.append(trip.start_date.date())
    for s in stops:
        if s.arrive:
            candidates.append(s.arrive.date())
        if s.depart:
            candidates.append(s.depart.date())
    for it in all_items:
        start, end = _item_span(it)
        d = start or end
        if d:
            candidates.append(d.date())
    return min(candidates) if candidates else None


def _add_months(d: _date, months: int) -> _date:
    """Calendar-month addition, clamping the day when the target month is
    shorter (e.g. 2026-08-31 + 6 -> 2027-02-28, not an OverflowError)."""
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return _date(year, month, day)


def _passport_expiry_warnings(travelers: list[Traveler], last_day: Optional[_date]) -> list[dict]:
    """D8: a traveler whose clear `passport_expiry` is before the trip's
    last day plus PASSPORT_VALIDITY_MONTHS gets a warning naming them. No
    decrypt needed (passport_expiry is a clear column). Nothing to compare
    against (no last_day, or no traveler has an expiry stored at all) means
    no warning — this only fires once there's an actual date to check."""
    if last_day is None:
        return []
    with_expiry = [t for t in travelers if t.passport_expiry]
    if not with_expiry:
        return []
    threshold = _add_months(last_day, PASSPORT_VALIDITY_MONTHS)
    out = []
    for t in with_expiry:
        expiry_day = t.passport_expiry.date()
        if expiry_day < threshold:
            out.append({
                "kind": "passport_expiry",
                "traveler_id": t.id,
                "message": (
                    f"{t.display_name}'s passport expires {expiry_day.isoformat()}, "
                    f"less than {PASSPORT_VALIDITY_MONTHS} months after the trip ends"
                ),
            })
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
    about one specific item.

    The two "coverage" checks (uncovered nights, missing transport) only ever
    alert on what's still in the future — a gap or a missing connection for a
    day that's already passed isn't actionable, and the alert clears itself
    out on its own the next day rather than needing to be dismissed. The
    other checks (date-range, impossible connections, timezone mismatches,
    missing country) are about data correctness rather than "still need to do
    this," so they keep firing regardless of date.

    Also flags stops with no country recorded but a resolved location cache
    (see _missing_country_warnings) — the suggested fix bundles the resolved
    country with a DST-aware timezone for the stop's arrival date, so a
    one-click accept never leaves the two half-fixed.

    Also flags travelers (plan-17, D8) whose passport_expiry is too close to
    the trip's last day — see _passport_expiry_warnings; that check's dict
    shape (`kind`/`traveler_id`/`message`) deliberately differs from the
    item/stop warnings above since it isn't about any item or stop."""
    today = _today()
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
        out.extend(_uncovered_night_warnings(stop, items_by_stop.get(stop.id, []), today))

    out.extend(_missing_transport_warnings(stops, items_by_stop, today))

    stop_by_id = {s.id: s for s in stops}
    all_items_with_stop = [(stop_by_id[it.stop_id], it) for it in all_items if it.stop_id in stop_by_id]
    out.extend(_impossible_connection_warnings(all_items_with_stop))

    out.extend(_timezone_mismatch_warnings(session, all_items, stops))
    out.extend(_missing_country_warnings(session, stops))

    # Every check above appends in *check-execution* order, not trip order —
    # a stop near the start of the trip whose only problem is a missing
    # country (the last check to run) would otherwise land at the very
    # bottom of the list, behind every date-range/coverage/transport warning
    # from stops later in the trip. Sort chronologically instead so the list
    # reads top-to-bottom the same way the trip does. item_date is ISO 8601
    # throughout (some checks use a bare date, others a full datetime) —
    # plain string comparison already orders those correctly since a date
    # string is a strict prefix of, and so sorts before, a same-day datetime
    # string.
    out.sort(key=lambda w: w.get("item_date") or "")

    trip = session.get(Trip, trip_id)
    if trip:
        travelers = session.exec(select(Traveler).where(Traveler.trip_id == trip_id)).all()
        last_day = _trip_last_day(trip, stops, all_items)
        out.extend(_passport_expiry_warnings(travelers, last_day))

    return out
