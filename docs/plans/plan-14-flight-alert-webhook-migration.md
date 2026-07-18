# Plan 14 — Migrate flight live-alerts from polling to AeroDataBox's webhook Flight Alert API

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Status: investigation plan, NOT ready to implement

Unlike the other plans in this directory, this one has open questions that
need answering **before** an agent can build it — see "Open questions /
required spikes" below. Do not start implementation until those are resolved
(either by a human with AeroDataBox/api.market account access, or by a
follow-up research pass once one is available). This doc exists to capture
the investigation so the eventual work doesn't have to re-derive it.

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
  access — same headline number this codebase already budgets against, but
  the "maximum credits per refill" phrasing in their pricing page suggests a
  balance/refill model rather than a flat monthly reset; not confirmed how
  that differs in practice.
- **Endpoints**: `GET/DELETE /subscriptions/webhook/{subscriptionId}` to
  inspect/remove a subscription; `GET /subscriptions/webhook` to list all;
  `/subscriptions/balance` for the separate Flight Alert credit balance.

## Open questions / required spikes

These need a real AeroDataBox/api.market account (or a support ticket) to
resolve — they aren't answerable from public marketing/docs pages alone:

1. **Auth compatibility.** The webhook endpoints in the OpenAPI spec require
   an `x-api-market-key` header — a different scheme from the
   `X-RapidAPI-Key`/`X-RapidAPI-Host` pair `backend/flight_live.py` currently
   sends (provisioned via RapidAPI, see `AERODATABOX_KEY`). This strongly
   suggests the Flight Alert API is exposed through **api.market**, a
   separate marketplace from RapidAPI, not necessarily reachable with the
   existing key. **Spike:** confirm whether the current RapidAPI-provisioned
   key works against `/subscriptions/webhook/*`, or whether a *separate*
   api.market account/key is required (and if so, whether it shares the same
   600-credit free allowance or is billed independently).
2. **Notification payload schema.** Public docs describe the wrapper
   (`FlightNotificationContract` containing "flights information") but not
   the field-level shape. It's *likely* the same `status`/`departure.gate`/
   `departure.revisedTime` shape the existing flight-status-by-number
   response already has (same underlying provider, same data) — `delay_min()`
   and `delay_str()` in `backend/flight_live.py` may well work unmodified —
   but this needs confirming against a real captured payload before relying
   on it, not assumed.
3. **Retry/delivery semantics.** Docs mention `maxDeliveryRetries` on
   subscription creation and that "each retry attempt costs the same as the
   original delivery" — need to understand default retry count and whether a
   flaky/slow webhook receiver risks burning credits on retries of
   notifications it already received (idempotency handling — see below).
4. **Credit balance / refill model**, not yet understood well enough to
   reason about budget the way the flat-polling comment in
   `backend/notifications.py` currently does.

## Sketch of the eventual implementation (once the above is resolved)

Not a committed design — written so the shape is visible, but expect it to
change once the open questions are answered.

- **New public endpoint**, `POST /webhooks/aerodatabox`, following the same
  pattern as the existing public webhook receivers in this app
  (`/ingest/email`'s `MAIL_INGEST_SECRET`, the GitHub deploy webhook's
  `DEPLOY_SECRET`) — shared-secret auth if AeroDataBox supports a signature/
  secret header, otherwise an unguessable path segment as a fallback.
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
