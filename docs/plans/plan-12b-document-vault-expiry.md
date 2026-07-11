# Plan 12b — Document vault: expiry reminder cron

Read `docs/plans/README.md` first (conventions, test gates, build workflow).
Also read `docs/plans/plan-12-document-vault.md` for full context — this
subplan implements one slice of it: the `expiry_date` → push-notification
trigger. It **does not** touch the frontend at all.

## Depends on

**Plan 12a** (`docs/plans/plan-12a-document-vault-crud.md`) must be merged
first — this plan queries the `UserDocument` table plan-12a creates, and adds
a trigger function next to the existing ones in `backend/notifications.py`.
It does not touch `document_crypto.py` or `vault.py` — `expiry_date` is
stored unencrypted specifically so this cron can query it directly (see
plan-12's Data model section).

## Goal

For each stored document with an `expiry_date`, push a reminder when that
expiry falls within 6 months of the end date of one of the owner's trips —
closing issue #60 on the metadata/notification side (plan-12a already closed
it on the "can I even store the expiry date" side).

## Scope

**In scope**: the trigger function, its wiring into the cron script, and the
`NotificationLog` dedup-key decision. **Out of scope**: any UI (plan-12c),
file storage/encryption (plan-12a, already done), OCR/auto-detected expiry
dates (plan-12, permanently out of scope for all subplans).

## Implementation steps

### 1. `NotificationLog` dedup key decision

`NotificationLog.item_id` currently means "an `ItineraryItem.id`". This
trigger keys off a `UserDocument.id` instead, which lives in a different
id namespace. Pick one (document it in the migration/PR description, don't
leave it implicit):

- **Option A (simpler, recommended)**: reuse `item_id` to hold the
  `UserDocument.id` directly. Safe in practice because nothing ever joins
  `NotificationLog.item_id` back to `ItineraryItem` without also filtering
  on `kind`, and `kind="document_expiry"` never collides with any
  `ItineraryItem`-based kind string. Zero schema change.
- **Option B (more explicit)**: add a `NotificationLog.entity: str = "item"`
  discriminator column via an Alembic migration, defaulting existing rows to
  `"item"`, and set it to `"document"` for these rows.

Whichever is picked, dedup the same way `_due_triggers` already does: a
`(item_id, kind)` pair (or `(item_id, kind, entity)` for Option B) existing
in `NotificationLog` means "already sent, skip."

### 2. `send_document_expiry_reminders` in `backend/notifications.py`

```python
def send_document_expiry_reminders(session, *, now=None, sender=send_push) -> int:
    """Push a reminder when a stored document's expiry_date falls within 6
    months of the end_date of one of its owner's trips. Returns count sent."""
```

Logic:

1. `now = now or datetime.now(timezone.utc).replace(tzinfo=None)` — naive
   UTC, per README §3. **Do not use `date.today()`** (see CLAUDE.md's
   timezone section on why that footgun keeps recurring in this codebase).
2. Load every `UserDocument` with a non-null `expiry_date`.
3. For each, find that document's owner's trips (join through
   `TripMembership` by `user_email`, same lookup `_recipients` already does
   elsewhere) whose `end_date` is within 6 months *before* `expiry_date`
   (i.e. `expiry_date - 6 months <= trip.end_date <= expiry_date` — the trip
   must end before the document expires, and the expiry must be close enough
   to matter; a document that already expired before the trip even starts is
   not "expiring soon", it's already invalid — treat that as a non-match for
   this reminder, not a special case to handle differently).
4. Dedup against `NotificationLog` per the key decided in step 1; skip if
   already sent for this `(document, trip)` pair — note the key is
   per-document, not per-(document, trip), so pick the **earliest** matching
   trip if a user has more than one trip in the window, to keep the
   dedup key simple (one reminder per document, ever, not one per trip).
5. Kind: `"document_expiry"`. Title: "{label or doc_type} expiring soon".
   Body: "{label} expires {expiry_date:%b %d, %Y} — before your trip to
   {trip.name} ends." Send to the same user's subscribed devices — reuse
   `_recipients(session, trip.id)` (already scoped to trip members, and the
   owner is a member of their own trip) rather than inventing a new
   per-user-only device lookup.
6. Same `PushSendError.expired` cleanup and `NotificationLog` row write as
   `send_due_notifications`.

### 3. Cron wiring

`scripts/send_notifications.py` `main()`: add
`send_document_expiry_reminders(session)` alongside the existing
`send_due_notifications`/`send_flight_alerts` calls, include its count in
the printed log line. No env-var gate needed (unlike `send_flight_alerts`'
`AERODATABOX_KEY` guard) — this trigger has no external API dependency, it's
pure DB query + push, so it's safe to always run.

## Tests (`tests/test_document_expiry.py`, new; model on
`tests/test_notifications.py` and `tests/test_flight_alerts.py`)

- Document expiring within 6 months of a trip's `end_date` → one
  notification, kind `document_expiry`; re-run with the same `now` → no
  resend.
- Document with no `expiry_date` → never fires.
- Trip ending more than 6 months before `expiry_date` → no fire.
- Document already expired relative to `now`, with a trip ending before that
  expiry but outside the 6-month window → no fire (not a "closer" match).
- User with two trips both inside the window → exactly one notification
  (earliest trip), not two.
- Two different users' documents don't cross-fire on each other's trips.
- Regression: `send_due_notifications` and `send_flight_alerts` behavior
  unchanged (import both existing test modules' fixtures, don't duplicate).

## Manual verification

1. Create a document (via plan-12a's API) with `expiry_date` 3 months out,
   for a user with a trip whose `end_date` is within that window.
2. Run `python scripts/send_notifications.py` manually and confirm exactly
   one push fires with the expected title/body.
3. Run it again immediately — confirm no duplicate push.

## Out of scope

- Any UI surfacing of expiry status (plan-12c's Settings list already shows
  `expiry_date`; the color-coded warning badge is a plan-12c concern, not
  this one).
- Configurable lookback window (hardcoded 6 months, matching issue #60's
  original ask — no env var, unlike `DEPARTURE_LEAD_HOURS`; revisit only if
  requested).
- Renewal tracking / marking a document as renewed.

## Gotchas

- Naive UTC throughout (README §3) — this is the third trigger function in
  `backend/notifications.py`; copy the discipline of the first two exactly,
  don't reintroduce `date.today()` or aware datetimes.
- The dedup-key choice in step 1 affects the migration — if Option B, that's
  a real Alembic revision touching an existing table with data in it
  (`NotificationLog`), so the migration must default existing rows to
  `entity="item"` explicitly, not leave the column nullable and hope.
- This subplan has no `frontend/src/` changes — plain commit and push, no
  build/amend step (README §2).
