# Plan 14 — Migrate flight live-alerts from polling to AeroDataBox's webhook Flight Alert API

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Status: IMPLEMENTED 2026-07-18

Shipped as `backend/flight_alert_subscriptions.py` (subscription client +
reconciler + credit auto-refill), `backend/routers/webhooks.py` (receiver),
`evaluate_flight_alert` extracted in `backend/notifications.py` (shared by
poller and receiver), wired into `scripts/send_notifications.py`. To activate
in production, add to `/opt/travelcomp/.env`:

```
AERODATABOX_WEBHOOK_SECRET=<long random string, e.g. openssl rand -hex 24>
PUBLIC_BASE_URL=https://tripplan.hups.club
```

Without those two vars everything behaves exactly as before (pure polling).
With them, the notification cron reconciles subscriptions each tick, polling
skips subscribed flights (and remains the per-flight fallback for failed
creates), and the credit balance auto-refills below a floor of
`FLIGHT_ALERT_CREDIT_FLOOR` (default 20) by `FLIGHT_ALERT_CREDIT_REFILL`
(default 50) API units.

**Rate limiting (found immediately in production, 2026-07-18):** the first
live reconcile run 429'd — RapidAPI's BASIC plan rejects two AeroDataBox
calls made back-to-back. Fixed in `backend/rate_limit.py`, a minimal
per-service call-spacing throttle shared by `flight_alert_subscriptions.py`
and `flight_live.py` (same key, same limit).

**Airport coverage checking (2026-07-18):** per the Flight Alert API's own
guidance — "there is no sense in subscribing to a flight which operates in
airports having poor or no live updates or ADS-B coverage: there simply will
be no updates" — `reconcile_subscriptions` now checks the origin airport's
live-updates feed status (`GET /health/services/airports/{icao}/feeds`, FREE
TIER) before creating a subscription, via `get_coverage()`. Confirmed this
matters with a live example: **Rome Fiumicino (FCO/LIRF) currently shows
`liveFlightUpdatesFeed: Down`** — the exact airport from the Rome→Zurich
timezone bug earlier in this session. A flight departing FCO right now would
consume a subscription slot and never deliver a single notification.

IATA→ICAO resolution (`GET /airports/Iata/{code}`) costs API quota (TIER 1,
not free), so it's cached permanently once resolved in the new
`AirportCoverage` table — airport codes don't change. The live-updates
feed-status check itself is free and re-checked every
`FLIGHT_ALERT_COVERAGE_RECHECK_DAYS` (default 7) since outages come and go.
A flight whose origin has no coverage is left unsubscribed — same mechanism
as a failed subscription create — so polling remains its fallback (and will
likely also get nothing useful from that airport, since polling draws on the
same underlying feed, but at least no credits/subscription slots are wasted
on a webhook that structurally cannot fire).

The open questions below were all resolved by live testing against the
production RapidAPI key (see "Spike results"). The implementation sketch
further down has been updated to match what was actually observed and can
now be built as written.

## Why

`backend/notifications.py:send_flight_alerts()` (plan-2) polls AeroDataBox's
flight-status-by-number endpoint on a flat schedule: every
`FLIGHT_ALERT_POLL_MINUTES` (45 min) for any flight within
`FLIGHT_ALERT_WINDOW_HOURS` (24h) of departure — roughly 32 calls per tracked
flight, win or lose, whether anything changed or not.

This has two real, found-in-review gaps:

1. **The 24h window is shorter than this app's own check-in-window feature
   expects.** `ItemEditModal.jsx`'s `checkin_window` field example placeholder
   is `"48h"`, and 48-hour check-in is standard on several major
   international carriers. A flight can get a "Check-in now open" push at
   T-48h while live delay/cancellation/gate polling hasn't started yet
   (doesn't start until T-24h) — an already-published cancellation in that
   gap sits silently until the flight enters the poll window.
2. **Flat polling wastes budget where it matters least and is too coarse
   where it matters most.** The AeroDataBox free tier is 600 units/month; a
   flat 45-min cadence spends the same budget 20+ hours before departure
   (when gate/delay info barely exists yet) as it does in the last hour
   (when it's most actionable and most wanted).

AeroDataBox now offers a **webhook-based Flight Alert API** (launched ~April
2026 per their changelog) that could eliminate both problems: subscribe a
flight number once, get pushed to on any actual change, pay only for alerts
that are actually sent (not for polls that found nothing).

## What's confirmed (from public docs — `aerodatabox.com`, `api.market`)

- **Delivery**: webhook/push, not polling. `POST
  /subscriptions/webhook/{subjectType}/{subjectId}` creates a subscription;
  `subjectType` is `FlightByNumber` (flight number) or `FlightByAirportIcao`
  (all movements at an airport — not needed here). AeroDataBox then POSTs a
  `FlightNotificationContract` to your webhook URL when that flight's data
  changes.
- **Coverage window**: notifications cover flights from **6h in the past to
  72h in the future** — comfortably covers the 48h check-in-window gap above,
  with no window-tuning needed.
- **Billing**: 1 credit per flight item actually included in a *sent*
  notification (not per poll, not per subscription-check). A flight with zero
  changes over its whole lifecycle costs 0 credits, vs. ~32 units today
  regardless of outcome.
- **Free tier**: the Basic plan (600 credits) includes Flight Alert API
  access — same headline number this codebase already budgets against. The
  balance/refill model this implies is now confirmed and documented in
  "Spike results" below: alert credits are a separate balance, refilled
  explicitly out of the API quota at 1:1.
- **Endpoints**: `GET/DELETE /subscriptions/webhook/{subscriptionId}` to
  inspect/remove a subscription; `GET /subscriptions/webhook` to list all;
  `/subscriptions/balance` for the separate Flight Alert credit balance.

## Spike results (2026-07-18, tested live with the production RapidAPI key)

All four open questions resolved by direct testing against
`aerodatabox.p.rapidapi.com` and the RapidAPI-specific OpenAPI spec
(`https://doc.aerodatabox.com/docs/openapi-rapidapi-v1.json` — note
doc.aerodatabox.com publishes *two* spec variants; the `x-api-market-key`
scheme that motivated question 1 belongs to the api.market variant only).

1. **Auth compatibility — RESOLVED: the existing RapidAPI key works.** Every
   `/subscriptions/*` endpoint (create, get, list, delete, balance, refill)
   accepted the production `AERODATABOX_KEY` with the standard
   `x-rapidapi-key`/`x-rapidapi-host` headers `backend/flight_live.py`
   already sends. Verified end-to-end: created a `FlightByNumber` webhook
   subscription for KL1395, inspected it, listed it, and deleted it — all
   HTTP 200/204. No api.market account needed.
2. **Notification payload schema — RESOLVED from the RapidAPI OpenAPI spec.**
   `FlightNotificationContract` = `{flights: [...], subscription: {...},
   balance: {...}}`. Each entry in `flights` is a
   `FlightNotificationItemContract` with `number`, `status`,
   `lastUpdatedUtc`, and `departure`/`arrival` as
   `FlightAirportMovementContract` — the **same movement shape the polling
   endpoint returns**, so `flight_live.delay_min()`/`delay_str()` and the
   gate-change check should work on `flights[i].departure` unmodified. Bonus:
   each item also carries `notificationSummary` and `notificationRemark`
   (human-readable strings) usable directly as push-notification body text.
3. **Retry/delivery semantics — RESOLVED.** Delivery is best-effort, no
   replay. Default `maxDeliveryRetries` is **0** for credit-based
   subscriptions (max allowed: 2); each retry costs the same as the original
   delivery. The receiver must be a public HTTP(S) URL on ports
   80/443/8008/8080/≥49152, accept a JSON POST, and return 2xx within 10
   seconds — **no auth/signature header support**, so the receiver endpoint
   must be secured by an unguessable path segment (the plan's fallback
   approach, now confirmed as the only option).
4. **Credit balance / refill model — RESOLVED.** Flight-alert credits are a
   **separate balance from the API quota, starting at 0**. Refill via `POST
   /subscriptions/balance/refill {"credits": N}` converts API quota units to
   alert credits at 1:1 (tested: worked on the current BASIC plan despite the
   spec summary labeling refill "TIER 1"). Semantics observed live:
   - A subscription created while the balance is 0 comes back
     `isActive: false`; it **auto-activated the moment the balance went
     positive** (no separate activation call exists or is needed).
   - Balance hitting 0 pauses all subscriptions; refilling resumes them.
   - Subscriptions never expire; billing is 1 credit per flight item per
     notification actually sent (a `FlightByNumber` notification carries 1
     flight, so effectively 1 credit per real change event).
   - The test left a residual balance of **5 credits** on the account
     (refills can't be reversed) — the eventual implementation will consume
     them.

## Implementation sketch (updated to match spike findings)

- **New public endpoint**, `POST /webhooks/aerodatabox/{secret}`, following
  the same pattern as the existing public webhook receivers in this app
  (`/ingest/email`'s `MAIL_INGEST_SECRET`, the GitHub deploy webhook's
  `DEPLOY_SECRET`). AeroDataBox confirmed to support **no** signature/secret
  header, so the unguessable path segment is the mechanism, not a fallback —
  generate it once (env var, e.g. `AERODATABOX_WEBHOOK_SECRET`), bake it into
  the subscription URL, and 404 on mismatch. Must respond 2xx within 10s —
  do the actual alert evaluation after acknowledging (or keep it fast: the
  evaluation logic is a few dict reads and DB writes, well under budget).
- **Credit management**: on startup or via the notification cron, check
  `GET /subscriptions/balance` and refill from the API quota
  (`POST /subscriptions/balance/refill`, 1 API unit = 1 credit) when it drops
  below a floor (e.g. 20). This is what keeps subscriptions active — a zero
  balance silently pauses ALL subscriptions (observed live), which would look
  exactly like "alerts stopped working". Expose `creditsRemaining` in
  `/health` or metrics so Prometheus can alert on it approaching zero.
- **Subscription lifecycle**: create a webhook subscription when a flight
  item is saved with a `flight_number` + future `depart_time`; delete it once
  the flight has departed (or the item/details are edited to remove the
  flight number, or the item is deleted). This is genuinely new state the
  current polling design doesn't need — polling just reads `item.details`
  fresh every tick; subscriptions have to be kept in sync with item lifecycle
  explicitly, including trip/item edits and deletes.
- **Idempotency**: reuse `NotificationLog` exactly as `send_flight_alerts`
  does today (`flight_cancel`, `flight_delay:{bucket}`, `flight_gate:{gate}`
  kinds) — the webhook receiver evaluates the same cancel/delay-bucket/
  gate-change logic currently in `send_flight_alerts`, just triggered by an
  inbound POST instead of a poll loop. Most of that logic
  (`_flight_label`, `DELAY_BUCKETS_MIN` escalation, the `_send` closure) can
  likely be extracted and shared rather than duplicated.
- **Rollout**: keep `send_flight_alerts` (polling) as a fallback path,
  feature-flagged by whether webhook subscription setup succeeds — don't
  delete the polling code until the webhook path has run reliably in
  production for a while. Rail alerts (`send_rail_alerts`,
  transport.rest) are unaffected either way — transport.rest has no
  equivalent webhook API as far as this investigation found, so rail stays
  on polling regardless of what happens here.

## Non-goals

- No change to `send_rail_alerts` — out of scope, no evidence transport.rest
  offers anything equivalent.
- Not touching `send_due_notifications`, `send_booking_reminders`, or
  `send_document_expiry_reminders` — those are schedule-based, not live-poll,
  and unaffected by this.
- Not resolving the tiered-polling idea (scale `FLIGHT_ALERT_POLL_MINUTES` by
  proximity to departure) — that's a smaller, independent, lower-risk
  improvement to the *existing* polling design and can ship on its own
  without waiting on this investigation.
