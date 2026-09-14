# Plan 16 — Trip calendar: day/week/month/trip views, print, and drag-and-drop planning mode

Read `docs/plans/README.md` first (conventions, test gates, build workflow).
This is the **parent** plan: it fixes the decisions every sub-plan shares and
argues the "why" once. Each sub-plan is one PR and is written to be executed
on its own by an agent with no other context, but it states decisions rather
than re-arguing them — the argument lives here.

| Sub-plan | Scope | Effort | Depends on |
|---|---|---|---|
| [plan-16a-reschedule-api.md](plan-16a-reschedule-api.md) | Backend: atomic `POST /trips/{id}/reschedule` that moves stops and shifts their items by the same number of days | M | — |
| [plan-16b-calendar-views.md](plan-16b-calendar-views.md) | Frontend: read-only calendar with Day / Week / Month / Trip views, menu + footer wiring, swipe nav | M–L | — |
| [plan-16c-calendar-print.md](plan-16c-calendar-print.md) | Print stylesheet + Print button for the calendar | S | 16b |
| [plan-16d-planning-mode.md](plan-16d-planning-mode.md) | Planning mode: drag/resize/create stop bands (pointer events, overlaps allowed), draft → Save via 16a, warnings, one-shot Undo | L | 16a, 16b |
| Deferred (see "Later" below) | Item-level drag between days; calendar in the public shared view; "default view" setting | — | 16d |

Recommended order: **16a and 16b in parallel** (no shared files), then 16c,
then 16d. 16a is pure backend (no frontend build); 16b/16c/16d touch
`frontend/src/` and must follow the two-commit build rule.

## Goal

A Google-Calendar-style view of a trip — one day, one week, one month, or
the whole trip laid out first day → last day — that can be printed, plus a
**planning mode** where the trip's stops are movable blocks: drag a stop to
new dates, resize it, create a new one, let them overlap, and on Save the
real `Stop` rows are created/updated **and every itinerary item inside a
moved stop moves by the same number of days** (a stop dragged 4 days later
takes its flights, hotel check-in/out, dinners and tours 4 days later too).

## Decisions shared by all sub-plans (state, don't re-argue)

### D1. The calendar reads the existing timeline payload — no new read API
`GET /trips/{id}/timeline` (`build_trip_timeline` in
`backend/routers/trips.py`) already returns every stop with its items, in
the order the app uses everywhere. The calendar consumes exactly that; it
never introduces a second "calendar events" endpoint whose ordering or
lazy-migration behaviour could drift from the timeline's. Derived
per-day structure is computed client-side (see D3).

### D2. Date range of the "Trip" view
First day = `min(trip.start_date, earliest stop.arrive, earliest dated item)`,
last day = `max(trip.end_date, latest stop.depart, latest dated item)`, each
term skipped when null. Stops/items are the truth; `Trip.start_date/end_date`
are optional and may be stale, so they only ever *widen* the range, never
narrow it. If nothing is dated at all, the Trip view shows an empty-state
message ("Nothing in this trip has a date yet") rather than a grid.

### D3. Which datetimes an item "has" — the single source of truth
There are exactly **eight** date-bearing fields on an item, and every
sub-plan (placement in 16b, shifting in 16a, dragging in 16d) must use the
same list, in this priority order for *placement*:

| kind(s) | primary date (placement) | span end | other shifted keys |
|---|---|---|---|
| flight, rail, river_transfer | `details.depart_time` | `details.arrive_time` | — |
| transfer | `details.depart_time` → else `scheduled_at` | `details.arrive_time` | — |
| accommodation | `details.checkin` → else `scheduled_at` | `details.checkout` | `details.bag_drop` |
| hire | `scheduled_at` | — | `details.pickup_time`, `details.dropoff_time` |
| everything else | `scheduled_at` | — | — |

Complete set of keys that carry a datetime: top-level `scheduled_at`; in
`details`: `checkin`, `checkout`, `bag_drop`, `depart_time`, `arrive_time`,
`pickup_time`, `dropoff_time`. This list is derived from the
`type="datetime-local"` fields in `frontend/src/components/ItemEditModal.jsx`
and from `_item_span` / `_transport_times` in `backend/validation.py`. The
placement rules match `itemDateKey` / `itemSortKey` in
`frontend/src/components/StopCard.jsx` — **reuse those helpers on the
frontend, don't reimplement them.** 16a adds the backend twin
(`backend/reschedule.py::ITEM_DATETIME_KEYS`) and a test that the two lists
agree, so a future kind that adds a ninth key fails a test rather than
silently not shifting.

All of these are stored as **local wall-clock strings with no zone**
(`"2026-09-14T10:30"`), per `docs/programmatic-api.md`. Shifting by whole
days preserves the time-of-day verbatim — no timezone arithmetic, ever.
`Stop.arrive/depart` are `datetime` columns holding the same convention.

### D4. Shift semantics (the rule 16a implements, 16d previews)
For each moved stop: `delta_days = new_arrive.date() − old_arrive.date()`.
If the old stop had no `arrive`, use `depart` for both sides; if it had
neither, `delta_days = 0` (its items keep their dates — there is nothing to
be relative to). Apply `delta_days` (whole days, time-of-day untouched) to
every present, parseable key from D3 on every item of that stop.
Consequences, all deliberate:

- **Resizing** a stop (arrive unchanged, depart moved) → `delta_days = 0`
  → items untouched. A hotel checkout is *not* auto-extended; the existing
  `GET /trips/{id}/date-warnings` will flag "checkout before departure" and
  16d shows those warnings after Save. Auto-extending would be guessing.
- Items are shifted **by the stop's delta, not clamped** into the new
  window. An item that was already outside its stop stays equally outside.
- `Expense` rows are logged real-world spend, not plan — never touched
  (matches `delete_stop`'s reasoning in `backend/routers/stops.py`).
- `status` is never changed by a move (a `completed` dinner moved into the
  future is a data-entry oddity for the user to fix, not for us to guess).
- `sort_order` is left alone — list ordering is by arrive date first, so it
  only breaks ties among same-day/undated stops, which a move doesn't
  affect.
- Every shifted item gets an `ItemHistory` row (`record_item_history`, op
  `"update"`, `source="reschedule"`) so the history modal shows the move.
  Stops have no history table; 16a's response returns the inverse batch so
  16d can offer a one-shot Undo instead.

### D5. Overlapping stops are allowed, everywhere
No validation rejects two stops sharing dates (a "base in Tokyo, side-trip
to Hakone" pattern is real). The calendar renders overlaps as stacked
lanes (D7). `validation.py`'s warnings are advisory and never block a save;
16a must not add an overlap check.

### D6. One atomic endpoint, not N PATCHes from the client
Save goes through `POST /trips/{trip_id}/reschedule` (16a), one request
carrying moves/creates/deletes. Reasons: atomicity (a half-applied
multi-stop drag is worse than a failed one); the item-shift rule (D4) must
exist in exactly one place, server-side, so PAT/programmatic-API users
(`docs/programmatic-api.md`) get the same behaviour as the UI; permissions
checked once. Editor role on the trip. Compare-and-set `base` per stop
(`backend/compare_and_set.py::resolve_fields`, the pattern from
`update_stop`) so two people planning at once get a 409, not a silent
clobber.

### D7. Layout is CSS grid + our own lane packing — no calendar library
Runtime deps are `react`, `react-dom`, `lucide-react` and a font; the main
bundle already trips Vite's 500 kB warning. A Google-style month/trip grid
is a 7-column CSS grid with week rows; stops are "all-day" bands spanning
columns, packed into lanes with the standard greedy interval-colouring
(sort by start, place each in the first lane whose last band ended before
it starts). That's ~40 lines and fully unit-testable. Don't add
FullCalendar/react-big-calendar/dnd-kit.

### D8. Drag uses Pointer Events, not HTML5 drag-and-drop
This app's primary device is an iPhone (see the safe-area and edge-swipe
notes in `frontend/src/App.jsx`). HTML5 `dragstart/drop` doesn't fire on
touch in Safari without a polyfill. `pointerdown` + `setPointerCapture` +
`pointermove` + `pointerup` works identically for mouse and touch, and the
drop target is computed from grid geometry (column = ⌊(x − gridLeft) /
cellWidth⌋, week row = ⌊(y − gridTop) / rowHeight⌋) — deterministic and
testable with synthetic events, no `elementFromPoint`. Set
`touch-action: none` on the drag handle only (not the grid) so vertical
scrolling still works elsewhere. Long-press (≈300 ms) to start a drag on
touch so a scroll-flick over a band isn't a move.

### D9. Where it lives in the shell
A **Calendar** entry in the hamburger `MenuDropdown` (next to Packing),
toggling a new `calendar` view state in `App.jsx` mutually exclusive with
`packing`/`editing`/`today` — same pattern as Packing. While in calendar
mode the footer's constant-use slot shows the view switcher
(Day · Week · Month · Trip) plus, for editors who are online, **Plan**
(16d) and **Print** (16c). Day view does not re-implement day rendering:
it exits into the existing Today-mode day for that date (16b adds an
`initialDay` prop to `TripTimeline`), because the per-kind cards, weather
banner, layovers and detail modals already live there.

### D10. Planning mode is online-only and not offline-queued
Like Share and Export PDF, it is hidden when `useOnline()` is false. The
batch endpoint is not routed through the plan-11 offline write queue — the
queue replays single-row PATCHes with per-field compare-and-set and can't
express "move a stop and shift its items atomically."

## Colour and identity
Each stop gets a deterministic colour from a small palette by its index in
timeline order (define `--stop-1 … --stop-8` next to the existing
`--kind-*` vars in `frontend/src/index.css`, dark and light theme values).
Items keep their kind colour (`--kind-<kind>`) so a chip is readable as
"a flight" at a glance; the band behind it says which stop.

## Later (deliberately not in 16a–16d)
- **Item drag between days** in planning mode (moves `scheduled_at`/the
  primary key from D3 and, if the target day is in another stop, calls
  `POST /items/{id}/move`). Natural follow-on to 16d; same pointer
  machinery.
- **Calendar in `SharedTripView`** (public token, read-only): 16b's
  components take a timeline prop, so this is wiring only.
- **"Open trips in Calendar by default"** setting, alongside
  `getDefaultToToday` in `frontend/src/settings.js`.
- **Weather in month cells** — the `/weather` endpoint is per-stop/day and
  cached; feasible, but 16b should not fetch it (keep the first version
  fast on a phone).
- **Hourly time-grid week view.** Week view in 16b is agenda-style (7
  columns, items listed chronologically). Itineraries have a handful of
  timed items per day; an hourly grid wastes a phone screen. Revisit only if
  asked.
