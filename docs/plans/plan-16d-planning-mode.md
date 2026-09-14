# Plan 16d — Planning mode: drag-and-drop stop scheduling

Read `docs/plans/README.md` first, then `docs/plans/plan-16-calendar.md`
(D3–D10 all apply). Depends on **16a** (the `reschedule` endpoint) and
**16b** (`TripCalendar.jsx`, `calendarModel.js`). Frontend only; two-commit
build rule.

## Goal

In calendar mode, an editor who is online taps **Plan** and the stop bands
become editable: drag a band to move the whole stop (duration preserved),
drag either end to resize it, drag across empty cells to create a new stop,
tap a band for rename/delete. Overlaps are allowed and shown as stacked
lanes. Nothing touches the server until **Save**, which posts one
`reschedule` batch; **Discard** throws the draft away. After Save the app
shows the trip's date warnings (so a hotel checkout left behind by a resize
is visible immediately) and offers a one-shot **Undo**.

## Files

- **`frontend/src/calendarModel.js`** (extend):
  - `applyDraft(timeline, draft) -> timeline'` — pure: returns a timeline
    whose stops reflect the draft (moved dates, temp-id creates, removed
    deletes) **and whose items are shifted by D4's rule** so the preview
    matches what the server will do. Implement the shift with the same
    key list as the backend (`scheduled_at` + `checkin, checkout, bag_drop,
    depart_time, arrive_time, pickup_time, dropoff_time`) and a
    `shiftDateStr(value, days)` that preserves the input shape exactly like
    `backend/reschedule.py::shift_datetime_str`. Export the key list as
    `ITEM_DATETIME_KEYS` — 16a's list-agreement test greps
    `ItemEditModal.jsx`; add a frontend test that this constant equals the
    same grep result so both sides stay pinned to one truth.
  - `draftToRequest(draft, originalStops) -> RescheduleRequest` — builds
    `moves` (with `base` = original `{arrive, depart}`), `creates` (with
    `client_ref` = the temp id), `deletes`. Only stops whose dates actually
    changed go into `moves`.
  - `cellFromPoint(gridRect, cols, rowHeight, x, y) -> {col, row}` and
    `dayKeyAt(weeks, {col,row})` — D8 geometry, pure.
- **New `frontend/src/components/PlanningOverlay.jsx`** — mounted inside
  `TripCalendar` when `planning` is true; owns the pointer machinery:
  - `pointerdown` on a band body / band edge handle / empty cell →
    `setPointerCapture`; on touch, start only after a 300 ms long-press
    (cancel on `pointermove` > 8 px before that). `touch-action: none` on
    handles and band bodies only.
  - `pointermove` → compute the target cell (D8), update a transient
    `dragPreview` (no draft mutation yet), render a ghost band and a
    "Sep 14 – Sep 17 (4 nights)" tooltip.
  - `pointerup` → commit into `draft`. Move keeps duration; resize clamps so
    `depart ≥ arrive`; create-drag yields a band and opens the inline
    "New stop" form (location, country — reuse `EditStopCard`'s field
    components; timezone left default).
  - Keyboard: with a band focused, ← → move ±1 day, Shift+← → resize the
    end, Delete removes — cheap accessibility win, and makes the logic
    testable without synthesising pointer geometry.
  - Escape cancels an in-progress drag.
- **`frontend/src/components/TripCalendar.jsx`** — accept `planning`,
  `draft`, `onDraftChange`; render from `applyDraft(timeline, draft)` when
  planning so item chips visibly move with their stop. Bands in planning
  mode show grab affordance + edge handles (`edit-btn` class, README 6).
- **`frontend/src/App.jsx`** — **Plan** button in the reserved footer slot
  (calendar mode, `canEdit(selectedTrip.role)`, `online`). While planning the
  slot becomes **Save · Discard** plus a "N changes" counter. Leaving
  calendar mode / switching trips / closing the tab with a non-empty draft
  → confirm (`beforeunload` + the in-app guard). On Save:
  1. `POST /trips/{id}/reschedule` via a new `rescheduleTrip(tripId, body)`
     in `frontend/src/api.js` (follow `req()`).
  2. 409 → show the conflict rows (`detail.conflicts`, same shape the
     offline banner renders — reuse `OfflineQueueBanner`'s `ConflictRow`
     presentation or a minimal list) and keep the draft so the user can
     re-fetch and retry; never auto-overwrite.
  3. Success → clear draft, refetch the timeline, exit planning, then fetch
     `GET /trips/{id}/date-warnings` and show them in a dismissible panel
     under the grid ("3 warnings after this change").
  4. Toast with **Undo** for ~10 s that posts `response.inverse`; if
     `undo_lossy`, the toast says "Undo (deleted stops can't be restored)".
- **`frontend/src/api.js`** — `rescheduleTrip`.
- **`docs/programmatic-api.md`** — no change (16a documented the endpoint).

## Behavioural rules (mirror of D4/D5 — the UI must not invent others)

- Moving a band by N days shifts its item chips by N days in the preview.
  Resizing shifts nothing.
- Two bands may occupy the same days; the lane packer stacks them. No
  "overlap" warning in the UI — the existing date-warnings endpoint is the
  only source of warnings, shown after Save.
- Undated stops are listed in the "Undated stops" strip with a **Place**
  button: tap, then tap a day → becomes a one-day band (a create-like move
  with `arrive = depart = that day`, and since the stop was undated,
  `delta_days = 0` → its items don't move; say so in a hint).
- A newly created stop has no items; its band still previews.
- Deleting a stop in the draft shows a struck-through band until Save; the
  Save confirm names the stops being deleted and their item counts, since
  that part of Undo is lossy.

## Tests

`frontend/src/__tests__/calendarModel.planning.test.js`:
- `applyDraft`: move +4 → stop dates and every date key of its items +4,
  time-of-day preserved, untouched keys absent; resize → items unchanged;
  undated → 0; temp create appears; delete disappears; original timeline
  object not mutated.
- `ITEM_DATETIME_KEYS` equals the `ItemEditModal.jsx` grep (see 16a).
- `draftToRequest`: unchanged stops omitted; `base` carries original
  values; temp ids become `client_ref`.
- `cellFromPoint`/`dayKeyAt`: boundaries (x exactly on a column edge
  belongs to the right-hand column), out-of-grid clamps.

`frontend/src/__tests__/PlanningOverlay.test.jsx` (fire synthetic
`pointerdown/move/up` with `clientX/Y`; mock `getBoundingClientRect`):
- Mouse drag of a band by two columns → `onDraftChange` with +2 days, same
  duration.
- Edge-handle drag → only `depart` changes; can't drag `depart` before
  `arrive`.
- Touch: a pointerdown that moves 20 px within 300 ms does **not** start a
  drag (it's a scroll); a 300 ms hold then move does.
- Escape mid-drag → no draft change.
- Keyboard ← → on a focused band → ±1 day.

`frontend/src/__tests__/App.planning.test.jsx`:
- Plan button hidden for viewers and when offline.
- Save posts the request built by `draftToRequest`, refetches, shows
  warnings from a mocked `/date-warnings`, shows Undo; Undo posts
  `inverse`.
- 409 keeps the draft and shows the conflicts.
- Discard clears the draft without a request.

Manual check (required, phone width + desktop): long-press-drag a stop on
a touch emulator (Chrome devtools device mode) and with a mouse; overlap
two stops; create by dragging across empty cells; Save; confirm the
timeline view shows the items on the new days and the history modal of one
shifted item shows a "reschedule" entry.
