# Plan 2 — Proactive flight delay / cancellation / gate-change push alerts

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Goal

The app can already (a) send push notifications from a cron job
(`backend/notifications.py` + `scripts/send_notifications.py`, runs every
~15 min on the server) and (b) fetch live flight status from AeroDataBox
(`check_flight` in `backend/routers/items.py`: status, departure/arrival delay
minutes, gate). Connect them: for flights near departure, poll AeroDataBox from
the cron and push an alert when the flight is delayed, cancelled, or the gate
changes. Backend-only.

## Constraints that shape the design

- **API budget.** AeroDataBox free tier = 600 units/month; a flight-status call
  costs multiple units. Poll only flights departing within
  `FLIGHT_ALERT_WINDOW_HOURS` (default 24) of now, at most every
  `FLIGHT_ALERT_POLL_MINUTES` (default 45) per flight, and stop after
  departure. Both configurable via env vars with those names. ~30 calls per
  tracked flight is the intended ceiling.
- **Idempotency.** Reuse the existing `NotificationLog` table (`item_id`,
  `kind` free-string) exactly as `_due_triggers` does — a `(item_id, kind)`
  row means "already sent". Escalation is encoded in the kind string (below).
- **No circular imports.** `backend/notifications.py` must not import from
  `backend/routers/items.py`. Extract the AeroDataBox HTTP call into a new
  module both can import.

## Implementation steps

### 1. Extract `backend/flight_live.py`

Move the AeroDataBox fetch out of `check_flight` into a new module:

```python
# backend/flight_live.py
AERODATABOX_KEY = os.getenv("AERODATABOX_KEY", "")

class FlightLiveError(Exception): ...   # message = user-facing detail

def fetch_flight(flight_iata: str, dep_date: str) -> Optional[dict]:
    """Raw AeroDataBox 'flight by number' lookup. Returns the first flight
    dict, or None when the API has no data for that flight/date.
    Raises FlightLiveError on network failure / non-2xx / non-JSON body."""
```

Port the existing request + error handling from `check_flight` **verbatim** —
it has carefully-ordered non-2xx / non-JSON handling with regression tests
(`tests/test_flight_check.py`); keep `record_external_call("aerodatabox", ...)`
metrics calls. Also move the pure helpers `delay_min(movement)` and
`delay_str(mins)` (currently nested inside `check_flight`) into this module as
top-level functions.

Then refactor `check_flight` in `backend/routers/items.py` to call
`flight_live.fetch_flight(...)` and translate `FlightLiveError` /
`None` into the same HTTPExceptions/responses it produces today. **All 13
existing tests in `tests/test_flight_check.py` must pass with at most
mechanical updates** (they monkeypatch `items_mod.httpx.Client` — update them
to monkeypatch `flight_live` internals or `flight_live.fetch_flight` instead).

Response shape reference (AeroDataBox, verified against their client schema):
`status` is PascalCase (`Expected|EnRoute|Boarding|Delayed|Departed|Arrived|Canceled|CanceledUncertain|Diverted|GateClosed|CheckIn|Unknown`);
`departure`/`arrival` each have `scheduledTime{utc,local}`,
`revisedTime{utc,local}` (absent until the airline publishes a revision),
`gate`, `terminal`. UTC strings look like `"2026-07-24 13:35Z"`-ish — parse
with the first 16 chars and `"%Y-%m-%d %H:%M"` as `delay_min` already does.

### 2. Alert triggers in `backend/notifications.py`

Add:

```python
DELAY_BUCKETS_MIN = [15, 30, 60, 120, 240]

def send_flight_alerts(session, *, now=None, sender=send_push,
                       fetch=None) -> int:
    """Poll near-departure flights and push delay/cancel/gate alerts.
    Returns number of alerts sent. `fetch` defaults to
    flight_live.fetch_flight (injectable for tests)."""
```

Logic per flight item (`kind == ItemKind.flight`, has `details.flight_number`
and `details.depart_time`):

1. Compute naive-UTC departure via the existing `_local_to_utc(depart_time,
   depart_tz)`. Skip unless `now < depart <= now + window`.
2. Throttle: skip if `details.get("flight_poll_at")` is within
   `FLIGHT_ALERT_POLL_MINUTES`. After polling, write the new timestamp
   (naive-UTC ISO, minutes precision) back into `details` — remember the
   JSON-mutation rule (README §4) — and commit.
3. Call `fetch(flight_iata, dep_date)` (same iata/date derivation as
   `check_flight`: `details.flight_number` stripped of spaces + uppercased;
   `details.depart_time[:10]`). On `FlightLiveError` or `None`, log the metric
   (fetch already does) and move on — never let one flight's failure kill the
   whole run.
4. Evaluate alert kinds, deduped against `NotificationLog` like
   `_due_triggers` does:
   - **Cancellation:** status in `("Canceled", "CanceledUncertain")` → kind
     `"flight_cancel"`, title "Flight cancelled", body with flight number +
     route.
   - **Delay escalation:** `dep_delay = delay_min(live["departure"])`; for the
     LARGEST bucket ≤ dep_delay, kind `f"flight_delay:{bucket}"` → title
     "Flight delayed", body like "QF1469 CBR→MEL now departing 11:20 (45m
     late)" using `revisedTime.local` for the shown time (same local-time
     display convention as `_notification_payload`). Send only the largest
     applicable bucket, not every bucket passed.
   - **Gate change:** live departure `gate` present, `details.origin_gate`
     present, and they differ → kind `f"flight_gate:{live_gate}"`, body
     "Gate changed: D12 → D15". (Both-present requirement avoids noise when
     the user never stored a gate.)
5. Send to the trip's subscribed devices exactly as `send_due_notifications`
   does — reuse `_recipients(session, stop.trip_id)` and the
   `PushSendError.expired` cleanup; log a `NotificationLog(item_id, kind)` row
   per trigger sent. Follow that function's structure closely.

### 3. Cron entry point

`scripts/send_notifications.py` `main()`: after the existing
`send_due_notifications` call, add `send_flight_alerts(session)` and include
its count in the printed log line. Guard: if `AERODATABOX_KEY` is unset, skip
silently (the cron shouldn't error on servers without the key).

### 4. Deployment note

Add to the plan-completion notes / commit message: the server's `.env` must
contain `AERODATABOX_KEY` for alerts to fire (the cron sources `.env`).

## Tests (`tests/test_flight_alerts.py`, new; model on `tests/test_notifications.py`)

Use the existing `client`/`session` fixtures, a fake `sender` capturing
payloads, a fake `fetch` returning canned AeroDataBox dicts, and explicit
`now=` values. Cover at minimum:

- Flight departing outside the window → fetch never called.
- Delay 45m → exactly one alert, kind `flight_delay:30`; re-run → no resend;
  delay grows to 70m on next poll → one new alert `flight_delay:60`.
- Status `Canceled` → `flight_cancel` alert once.
- Gate stored "D12", live "D15" → gate alert; no stored gate → no alert.
- Throttle: second call within `FLIGHT_ALERT_POLL_MINUTES` → fetch not called
  again (assert via call-counting fake).
- `fetch` raising `FlightLiveError` for one flight doesn't prevent alerts for
  the next flight.
- `send_due_notifications`'s existing tests all still green (regression).

Also keep/adapt all of `tests/test_flight_check.py` (step 1 refactor).

## Gotchas

- `_due_triggers` loads ALL NotificationLog rows into a set — fine to mimic.
- `details["flight_poll_at"]` writes happen inside the cron transaction;
  commit them even when no alert fires, or the throttle does nothing.
- Naive-UTC everywhere (README §3). `now = now or datetime.now(timezone.utc).replace(tzinfo=None)`.
- Don't touch the frontend; this is backend + script only, so no build/amend
  step — plain commit and push.
