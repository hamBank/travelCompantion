# Plan 16a — `POST /trips/{trip_id}/reschedule` (backend only)

Read `docs/plans/README.md` first, then `docs/plans/plan-16-calendar.md`
(decisions D3, D4, D5, D6 are what this sub-plan implements). Backend
only: no `frontend/src/` changes, no build step.

## Goal

One atomic, editor-only endpoint that (1) creates, updates and deletes a
trip's stops in a single transaction and (2) shifts every date-bearing
field of every item inside a moved stop by the stop's whole-day delta,
recording item history — so a UI (16d) or a script can say "move Kyoto four
days later" and have the flights, hotel and dinners follow.

## Files

- **New `backend/reschedule.py`** — pure logic, no FastAPI:
  - `ITEM_DATETIME_KEYS = ("checkin", "checkout", "bag_drop", "depart_time",
    "arrive_time", "pickup_time", "dropoff_time")` — the D3 list, `details`
    keys only; `scheduled_at` is the top-level column handled separately.
  - `shift_datetime_str(value: str, delta_days: int) -> str` — parse
    `"YYYY-MM-DD"` or `"YYYY-MM-DDTHH:MM[:SS]"`, add `timedelta(days=delta)`,
    format back **in the same shape it came in** (date-only stays
    date-only; seconds kept only if present). Returns the input unchanged
    if it doesn't parse — never raise on user data.
  - `stop_delta_days(old_arrive, old_depart, new_arrive, new_depart) -> int`
    — D4: arrive-based, depart fallback, 0 if the old stop was undated.
  - `shift_item(item: ItineraryItem, delta_days: int) -> bool` — mutates
    `scheduled_at` and each present key in `ITEM_DATETIME_KEYS`; reassigns
    `item.details = {**item.details, ...}` (README convention 4) so
    SQLAlchemy persists it. Returns whether anything changed. `delta_days
    == 0` → returns False without touching the row.
- **`backend/routers/trips.py`** — the route, next to `trip_date_warnings`.
- **`backend/models.py`** — request/response models (below); no table
  changes, so **no Alembic migration**.
- **`docs/programmatic-api.md`** — add a "Reschedule stops" section with a
  curl example, next to the existing create-flow docs.
- **`tests/test_reschedule.py`** — new.

## API

`POST /trips/{trip_id}/reschedule` — `require_trip_role(..., TripRole.editor)`.

Request (`RescheduleRequest`):
```json
{
  "moves": [
    {"stop_id": 12, "arrive": "2026-10-04T00:00", "depart": "2026-10-07T00:00",
     "base": {"arrive": "2026-09-30T00:00", "depart": "2026-10-03T00:00"}}
  ],
  "creates": [
    {"location": "Hakone", "country": "JP", "arrive": "2026-10-05T00:00",
     "depart": "2026-10-06T00:00", "timezone": "GMT+9", "client_ref": "tmp-1"}
  ],
  "deletes": [15]
}
```
- `moves[].arrive/depart` are the **full new values** (either may be null
  to clear). `base` is optional; when present, compare-and-set each field
  via `resolve_fields` exactly as `update_stop` does, and on any conflict
  raise 409 with `{"conflicts": [...], "current": {...}}` **before applying
  anything** (validate all moves first, then apply — atomicity, D6).
- `creates[]` reuse `StopCreate`'s fields plus an optional `client_ref`
  string echoed back so the caller can map temp ids → real ids.
- `deletes[]` must belong to this trip; reuse `delete_stop`'s exact
  cascade (attachments flushed first, expenses unlinked not deleted —
  extract that body into a helper `_delete_stop_cascade(session, stop)` in
  `backend/routers/stops.py` and call it from both places rather than
  copying it).
- Any stop id in `moves`/`deletes` not in `trip_id` → 404 (don't leak ids
  across trips; matches the 404-for-no-access convention). Same id in both
  `moves` and `deletes` → 422.
- Empty request → 200 no-op (idempotent; the UI may Save with nothing
  changed).

Response (`RescheduleResponse`):
```json
{
  "stops": [ ...StopRead for every stop in the trip, timeline order... ],
  "created": [{"client_ref": "tmp-1", "id": 31}],
  "shifted_items": [{"item_id": 88, "stop_id": 12, "delta_days": 4}],
  "inverse": {"moves": [{"stop_id": 12, "arrive": "2026-09-30T00:00", "depart": "2026-10-03T00:00"}],
              "creates": [], "deletes": [31]}
}
```
`inverse` is a request body that undoes this call (moves back with the old
values; deletes what was created; **created-from-deleted is not attempted**
— a deleted stop's items are gone, so `inverse.creates` is always `[]` and
the response also carries `"undo_lossy": true` when `deletes` was
non-empty). 16d uses it for a one-shot Undo toast.

Order of application inside the transaction: validate everything → creates
→ moves (+ item shifts + history rows) → deletes → single `commit()`. Item
history rows use `record_item_history(session, item, "update",
user["email"], before=snapshot_before, source="reschedule")` from
`backend/routers/items.py`.

## Side-effects to handle (not optional)

1. **`NotificationLog` idempotency.** Rows are keyed `(item_id, kind)`
   (`backend/models.py`). A "departure" reminder already sent for the *old*
   date would suppress the reminder for the *new* date. For every shifted
   item whose new primary date is in the future, delete its
   `NotificationLog` rows. Test it.
2. **Flight alert subscriptions** (`backend/flight_alert_subscriptions.py`,
   reconciled 4-hourly by `scripts/reconcile_flight_alerts.py`). Read that
   reconciler: if it derives the desired subscription set from stored flight
   items' `depart_time` and diffs against AeroDataBox, a shifted flight is
   picked up on the next tick with no work here — add a one-line note in the
   route docstring saying so. If it does **not** (e.g. it keys on item id
   only), do the minimum so a moved flight is re-subscribed on the next
   tick (mark stale, don't call AeroDataBox from this endpoint — README
   convention 7 and the budget note in `CLAUDE.md`).
3. **Weather cache** (`WeatherCache`) is keyed by location/date, not by
   stop — nothing to invalidate. State this in the docstring so the next
   person doesn't go looking.

## Tests (`tests/test_reschedule.py`, use `client`/`session` from `tests/conftest.py`)

Unit (`backend/reschedule.py`):
- `shift_datetime_str`: date-only stays date-only; `T10:30` keeps `10:30`;
  seconds preserved iff present; month/year rollover; unparseable → unchanged.
- `stop_delta_days`: arrive-based; depart fallback; undated → 0; negative.
- `shift_item` covers **each** key in `ITEM_DATETIME_KEYS` plus
  `scheduled_at`; details reassigned (new dict identity); delta 0 → False.
- **List-agreement guard:** assert `set(ITEM_DATETIME_KEYS) | {"scheduled_at"}`
  equals the set of datetime keys greppable from
  `frontend/src/components/ItemEditModal.jsx` (read the file, regex
  `datetime-local" value=\{d\('(\w+)'\)` and `core\.scheduled_at`). Cheap,
  and it's the only thing that stops a ninth key from silently not shifting.

API:
- Editor moves a stop +4 days: stop updated; a flight (`depart_time`,
  `arrive_time`), an accommodation (`checkin`, `checkout`, `bag_drop`) and an
  activity (`scheduled_at`) in it all +4 with time-of-day intact; an item
  with no dates untouched; `shifted_items` lists exactly the changed ones;
  one `ItemHistory` row per shifted item with `source == "reschedule"`.
- Resize only (arrive same, depart +2) → no item changes, `shifted_items == []`.
- Undated stop moved → delta 0, items untouched.
- Overlapping result (two stops now sharing dates) → 200 (D5).
- `creates` returns `client_ref → id`; `deletes` cascades (attachment gone,
  expense unlinked with `stop_id/item_id` nulled, not deleted).
- Atomicity: a batch whose second move has a `base` conflict → 409 and the
  first move was **not** applied.
- Viewer → 403; stop id from another trip → 404; id in both lists → 422;
  empty body → 200 with unchanged stops.
- `inverse` round-trip: POST the response's `inverse` → stops back to
  original dates and the shifted items back to original datetimes;
  `undo_lossy` true iff deletes were present.
- NotificationLog rows for a shifted future item are removed; rows for an
  unshifted item survive.

Run both suites before pushing (backend only changed, but run
`cd frontend && npx vitest run` anyway per README). Open the PR non-draft
with auto-merge per `CLAUDE.md`.
