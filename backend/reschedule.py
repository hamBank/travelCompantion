"""Pure logic for `POST /trips/{trip_id}/reschedule` (plan 16a) — shifting a
moved stop's dates and every date-bearing field of its items by the same
whole-day delta. No FastAPI, no session here; the route lives in
`backend/routers/trips.py` and calls into this module.

See `docs/plans/plan-16-calendar.md` decisions D3 (which fields carry a
datetime) and D4 (the shift rule) — this module is their implementation.
Datetimes throughout this app are local wall-clock strings/columns with no
timezone (see CLAUDE.md's "Timezone handling" section); shifting by whole
days must never do timezone arithmetic — it just adds `timedelta(days=...)`
to naive values, preserving time-of-day exactly.
"""
from datetime import datetime, timedelta
from typing import Optional

from .models import ItemKind, ItineraryItem

# The D3 list of `details` keys that carry a datetime. `scheduled_at` is the
# top-level column and is handled separately (it's a real datetime, not a
# string) — see shift_item below. Kept as its own module-level constant
# (rather than inlined) so tests/test_reschedule.py can assert this set stays
# in lockstep with the `datetime-local` fields in
# frontend/src/components/ItemEditModal.jsx: a future kind that adds a ninth
# datetime key should fail that test rather than silently not shift.
ITEM_DATETIME_KEYS = (
    "checkin", "checkout", "bag_drop",
    "depart_time", "arrive_time",
    "pickup_time", "dropoff_time",
)

# Accepted shapes for a stored local wall-clock datetime string, most-specific
# first so e.g. seconds are only dropped when the input genuinely had none.
_STR_FORMATS = ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d")


def shift_datetime_str(value: str, delta_days: int) -> str:
    """Shift a local wall-clock date/datetime string by whole days, keeping
    its original shape — a date-only string stays date-only, seconds are
    kept iff the input had them, time-of-day is untouched. Returns `value`
    unchanged if it isn't a `str` or doesn't parse as one of the expected
    shapes: this reads free-form imported/typed data, so it must never raise.
    """
    if not isinstance(value, str) or not value:
        return value
    for fmt in _STR_FORMATS:
        try:
            dt = datetime.strptime(value, fmt)
        except ValueError:
            continue
        return (dt + timedelta(days=delta_days)).strftime(fmt)
    return value


def stop_delta_days(
    old_arrive: Optional[datetime], old_depart: Optional[datetime],
    new_arrive: Optional[datetime], new_depart: Optional[datetime],
) -> int:
    """D4: the whole-day delta a stop moved by. Arrive-based; falls back to
    depart on both sides when there's no arrive; 0 when the old stop had
    neither date (an undated stop's items have nothing to be relative to,
    so they stay put). Comparing calendar dates (not full datetimes) is
    deliberate — a stop whose arrive time-of-day itself changed without its
    calendar day changing is a resize, not a move (see the docstring on
    shift_item's delta==0 short-circuit)."""
    old_anchor = old_arrive or old_depart
    new_anchor = new_arrive or new_depart
    if old_anchor is None or new_anchor is None:
        return 0
    return (new_anchor.date() - old_anchor.date()).days


def shift_item(item: ItineraryItem, delta_days: int) -> bool:
    """Shift every present, parseable datetime field on `item` — the
    top-level `scheduled_at` column plus every ITEM_DATETIME_KEYS entry in
    `item.details` — by `delta_days` whole days, time-of-day untouched.
    Mutates `item` in place and returns whether anything actually changed.

    `delta_days == 0` (an undated-stop move, or a resize where arrive didn't
    change — see D4) is a no-op: returns False without touching the row, so
    callers can skip it for history/shifted_items bookkeeping entirely.
    """
    if delta_days == 0:
        return False
    changed = False
    if item.scheduled_at is not None:
        item.scheduled_at = item.scheduled_at + timedelta(days=delta_days)
        changed = True

    details = item.details or {}
    new_details = dict(details)
    details_changed = False
    for key in ITEM_DATETIME_KEYS:
        val = details.get(key)
        if not val:
            continue
        shifted = shift_datetime_str(val, delta_days)
        if shifted != val:
            new_details[key] = shifted
            details_changed = True
    if details_changed:
        # README convention 4 / CLAUDE.md convention 4: reassign a new dict
        # identity so SQLAlchemy detects the change on the JSON column —
        # mutating `details` in place would silently not persist.
        item.details = new_details
        changed = True

    return changed


def _parse_local(value) -> Optional[datetime]:
    """Best-effort parse of a stored local wall-clock value — either an
    already-a-datetime column (`scheduled_at`) or one of the string shapes
    `shift_datetime_str` understands. Returns None on anything else."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    for fmt in _STR_FORMATS:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def item_primary_dt(item: ItineraryItem) -> Optional[datetime]:
    """The item's D3 "primary date for placement" as a naive datetime, used
    by the reschedule route to decide whether a shifted item's stale
    NotificationLog rows need clearing (a reminder already sent for the old
    date must not suppress the one for the new date). Same per-kind
    priority as the calendar placement table in
    docs/plans/plan-16-calendar.md — not `frontend/src/components/
    StopCard.jsx`'s full itemDateKey (which also handles transfer's
    scheduled_at fallback and other UI display nuances not needed here for a
    coarse "is this roughly in the future" check).
    """
    d = item.details or {}
    if item.kind in (ItemKind.flight, ItemKind.rail, ItemKind.river_transfer):
        return _parse_local(d.get("depart_time"))
    if item.kind == ItemKind.transfer:
        return _parse_local(d.get("depart_time")) or _parse_local(item.scheduled_at)
    if item.kind == ItemKind.accommodation:
        return _parse_local(d.get("checkin")) or _parse_local(item.scheduled_at)
    return _parse_local(item.scheduled_at)
