# Push notifications

Every push notification the app sends is triggered from one place:
`backend/notifications.py`, run by a single cron entry point
(`scripts/send_notifications.py`) on a fixed schedule. There is no other path
to a push notification — `send_push()` (`backend/push.py`) is only ever
called from inside this module (via each function's `sender` parameter,
which defaults to it).

```
travelcomp-notifications.timer (systemd, every 15 min)
        │
        ▼
scripts/send_notifications.py
        │
        ├─ send_due_notifications()          — schedule-based: check-in / departure
        ├─ send_flight_alerts()               — live-polled: flight delay/cancel/gate
        ├─ send_rail_alerts()                 — live-polled: rail delay/cancel/platform
        ├─ send_booking_reminders()           — schedule-based: booking deadlines
        └─ send_document_expiry_reminders()   — schedule-based: passport/visa expiry
```

All five are **idempotent** via the shared `NotificationLog` table
(`item_id`, `kind`) — a `(item_id, kind)` row means "already sent"; running
the cron any number of times per real-world event sends at most one
notification per kind per item. Recipients are always every device
subscribed (`PushSubscription`) by every member of the relevant trip
(`_recipients()`); a subscription that comes back expired (404/410 from the
push service) is deleted on the spot.

---

## Schedule

One systemd timer drives everything — `travelcomp-notifications.timer`,
created and enabled by `deploy.sh`:

```
OnCalendar=*:0/15        # every 15 minutes
RandomizedDelaySec=60
Persistent=true          # catches up after a missed run (e.g. server was down)
```

There is no separate schedule per notification type — all five functions run
on every 15-minute tick. What differs between them is *what counts as due* at
that moment (see below), not how often the cron itself runs.

A stale, missed trigger is **not** fired late without limit: the check-in/
departure triggers (`send_due_notifications`) and the booking-deadline
triggers (`send_booking_reminders`) both check `notify_at < now -
GRACE_HOURS` (6 hours) and silently skip if the moment has passed by more
than that — e.g. after a cron outage, a check-in window that opened 10 hours
ago no longer pushes a now-meaningless "check-in is open" alert. The live-poll
triggers (flight/rail alerts) have no separate staleness check — they're
naturally bounded by the departure window instead (see below). The document
expiry trigger has no staleness window either — it fires exactly once per
document, whenever the cron first notices the expiry/trip-end dates line up,
however late.

---

## Trigger reference

| Function | Kind(s) | Fires when | Source of truth |
|---|---|---|---|
| `send_due_notifications` | `checkin_heads_up` | `CHECKIN_HEADS_UP_MINUTES` (20 min) before a flight's check-in window opens | `details.checkin_window` + `details.depart_time`/`depart_tz` on a `flight` item |
| `send_due_notifications` | `checkin` | The moment a flight's check-in window opens | same |
| `send_due_notifications` | `departure` | `DEPARTURE_LEAD_HOURS` (3h, env-configurable) before departure | `details.depart_time`/`depart_tz` on a `rail`, `transfer`, or `river_transfer` item |
| `send_flight_alerts` | `flight_cancel` | AeroDataBox reports `status` in `Canceled`/`CanceledUncertain` | live poll (below) |
| `send_flight_alerts` | `flight_delay:{bucket}` | Departure delay crosses a new bucket in `DELAY_BUCKETS_MIN` (`[15, 30, 60, 120, 240]` min) | live poll |
| `send_flight_alerts` | `flight_gate:{gate}` | Live gate differs from `details.origin_gate`, and a gate was actually stored | live poll |
| `send_rail_alerts` | `rail_cancel` | transport.rest reports the service cancelled | live poll (below) |
| `send_rail_alerts` | `rail_delay:{bucket}` | Departure delay crosses a new bucket in `DELAY_BUCKETS_MIN` | live poll |
| `send_rail_alerts` | `rail_platform:{platform}` | Live platform differs from `details.depart_platform`, and one was stored | live poll |
| `send_booking_reminders` | `booking_soon` | 7 days before `book_by`, 09:00 destination-local | `details.needs_booking` + `details.book_by` on any pending item |
| `send_booking_reminders` | `booking_due` | 09:00 destination-local on `book_by` itself | same |
| `send_document_expiry_reminders` | `document_expiry` | Once, when a document's `expiry_date` falls within `DOCUMENT_EXPIRY_LOOKAHEAD_DAYS` (183 days, ~6 months) of the end date of one of the owner's trips | `UserDocument.expiry_date` vs. `Trip.end_date` |

"Bucket" delay alerts only fire once per bucket per item — a steady 45-minute
delay doesn't re-alert every poll, but a *growing* delay (45m → 70m) crosses
into a new, larger bucket and sends a fresh, more urgent alert. (A delay that
later *shrinks* into a smaller bucket it hasn't visited yet will also alert —
this reads as a spurious "Flight delayed" notification on an improving
flight; a known rough edge, not something guarded against today.)

---

## Live-poll triggers (flight/rail)

`send_flight_alerts` and `send_rail_alerts` are different in kind from the
other three: instead of computing a fixed instant from stored data, they poll
an external live-status API for any transport item departing soon, and act on
whatever comes back.

| | Flight (AeroDataBox) | Rail (transport.rest) |
|---|---|---|
| Poll window before departure | `FLIGHT_ALERT_WINDOW_HOURS` (24h, env) | `RAIL_ALERT_WINDOW_HOURS` (24h, env) |
| Minimum gap between polls of the same item | `FLIGHT_ALERT_POLL_MINUTES` (45 min, env) | `RAIL_ALERT_POLL_MINUTES` (30 min, env) |
| Requires | `AERODATABOX_KEY` env var — **silently skipped in the cron if unset**, no error, no log line distinguishing "no delays" from "never configured" | none — free, unauthenticated, no key |
| Per-item prerequisites | `details.flight_number` + `details.depart_time` | `details.train_number` + `details.origin` + `details.depart_time` |

The tighter flight poll window/gap exists specifically to stay under
AeroDataBox's free-tier budget (600 units/month) — see the constants' comments
in `backend/notifications.py`. There's no equivalent ceiling for rail, since
transport.rest has no published quota, but the gap is still bounded so a
misbehaving cron doesn't hammer someone else's free infrastructure.

The last poll time is stored back into the item's own `details`
(`flight_poll_at` / `rail_poll_at`) *before* the external call, so a failing
lookup still gets throttled — an API outage doesn't retry every 15-minute
tick. One item's fetch failure (`FlightLiveError`/`RailLiveError`) is caught
and skipped without aborting the rest of that run's polling.

---

## Configuration (env vars)

| Var | Default | Effect |
|---|---|---|
| `DEPARTURE_LEAD_HOURS` | `3` | Lead time for the rail/transfer/river_transfer `departure` reminder |
| `FLIGHT_ALERT_WINDOW_HOURS` | `24` | How far ahead a flight starts being live-polled |
| `FLIGHT_ALERT_POLL_MINUTES` | `45` | Minimum gap between AeroDataBox polls per flight |
| `RAIL_ALERT_WINDOW_HOURS` | `24` | How far ahead a train starts being live-polled |
| `RAIL_ALERT_POLL_MINUTES` | `30` | Minimum gap between transport.rest polls per train |
| `AERODATABOX_KEY` | unset | Required for `send_flight_alerts` to run at all; unset = flight live-tracking silently no-ops every cron tick |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` | unset | Required for *any* push to actually send — see `backend/push.py`. Without these, all five functions still run and log to `NotificationLog` as normal, but every send raises `PushSendError` (caught per-subscriber, so it doesn't break the run) |
| `VAPID_CONTACT_EMAIL` | `admin@tripplan.hups.club` | Contact address in the VAPID JWT claim |

`CHECKIN_HEADS_UP_MINUTES` (20), `GRACE_HOURS` (6), `DELAY_BUCKETS_MIN`
(`[15, 30, 60, 120, 240]`), and `DOCUMENT_EXPIRY_LOOKAHEAD_DAYS` (183) are not
env-configurable — they're module-level constants in `backend/notifications.py`.

---

## Timezone handling

Every trigger compares against real UTC "now". Stored `depart_time`/`book_by`
values are local wall-clock, so they're converted via `_local_to_utc()`,
preferring (in order): the item's own `details.depart_tz` → the item's stop's
`timezone` column → the stop's longitude, approximated at 15°/hour → UTC as a
last resort. This mirrors the frontend's own local-time handling
(`StopCard.jsx:toUtcMs`) so the notification and the in-app view agree on
when things actually happen. See `CLAUDE.md`'s "Timezone handling" section
for the wider set of clock-related gotchas across this codebase.

---

## Verifying on the server

```bash
# Timer enabled and last run's result
systemctl is-enabled travelcomp-notifications.timer
systemctl status travelcomp-notifications.service

# Recent activity — each line is one cron tick's summary
tail -50 /var/log/travelcomp/notifications.log

# Confirm the required keys are actually set (not just documented)
grep -E '^(AERODATABOX_KEY|VAPID_PRIVATE_KEY|VAPID_PUBLIC_KEY)=' /opt/travelcomp/.env
```

`scripts/smoke_check.sh`'s check 4 also verifies the timer is enabled and its
paired service didn't last fail — see `docs/plans/README.md` conventions and
`CLAUDE.md`'s Monitoring section for the broader alerting setup.
