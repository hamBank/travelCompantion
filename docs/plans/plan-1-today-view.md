# Plan 1 — "Today" view

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Goal

The timeline is organized by stop — right for planning, wrong for mid-trip use.
Add a **Today** mode that shows only items occurring today, across all stops,
so a traveller opening the app sees "what's next" without scrolling the whole
trip. Frontend-only; no backend changes.

## Behavior spec

- A `📅 Today` footer button (next to `🎒 Packing` in `frontend/src/App.jsx`)
  toggles Today mode, mutually exclusive with Packing and Edit modes (mirror
  exactly how the `packing` state is wired: set it false in `openTrip`/`goBack`,
  and have the Packing/Today buttons clear each other).
- In Today mode, TripTimeline renders the same StopCards, but each stop's
  `items` are filtered to those occurring "today" (user's local date), and
  stops with no matching items are dropped entirely.
- "Occurs today" per kind:
  - `flight` / `rail` / `river_transfer`: `details.depart_time` date == today
    **or** `details.arrive_time` date == today (a redeye arriving today counts).
  - `accommodation`: today falls within `details.checkin` .. `details.checkout`
    (inclusive, date-part comparison; if no checkout, checkin date only).
  - everything else: `scheduled_at` date == today.
  - Items with no date at all: excluded (exception: `note` items with
    `details.important` — include those, they're pinned announcements).
- Empty state: "Nothing scheduled today." plus a button/link to switch back to
  the full timeline.
- The button shows regardless of trip dates (a trip not spanning today just
  shows the empty state). Keep it simple; auto-defaulting to Today when the
  trip is in progress is explicitly out of scope.

## Implementation steps

1. **Helper (pure function, unit-testable).** In
   `frontend/src/components/StopCard.jsx`, next to the existing exported
   `itemDateKey`, add and export:

   ```js
   // Does this item occur on the given local date ("YYYY-MM-DD")?
   export function itemOccursOn(item, dateKey) { ... }
   ```

   Reuse the same field-fallback logic as `itemDateKey` (look at it before
   writing). Date-part comparison is string-based: `String(v).split('T')[0]`.
   For the accommodation range use string comparison — ISO date strings order
   lexicographically.

2. **TripTimeline filter.** `frontend/src/components/TripTimeline.jsx`: accept
   a new optional prop `filterDate` (a `"YYYY-MM-DD"` string or null). After
   `timeline` loads, when `filterDate` is set derive:

   ```js
   const visibleStops = filterDate
     ? timeline.stops
         .map(s => ({ ...s, items: s.items.filter(i => itemOccursOn(i, filterDate)) }))
         .filter(s => s.items.length > 0)
     : timeline.stops
   ```

   and render from `visibleStops` everywhere the component currently uses
   `timeline.stops` for display. **Careful:** the cross-stop layover
   computation and the `allItemsRef` j/k-navigation list should keep using the
   UNfiltered stops so modal navigation still walks the whole trip. Also render
   the empty state when `filterDate && visibleStops.length === 0`.

3. **App shell toggle.** `frontend/src/App.jsx`: add `today` state alongside
   `packing`; a footer button styled identically to the Packing toggle
   (accent background when active, label `📅 Today` / `📅 All days` when
   active); pass
   `filterDate={today ? new Date().toLocaleDateString('sv-SE') : null}`
   (`sv-SE` yields `YYYY-MM-DD` in local time — do NOT use
   `toISOString().slice(0,10)`, that's UTC and wrong in the evening in
   positive-offset timezones).

## Tests (frontend — add to `frontend/src/__tests__/StopCard.test.jsx`)

`describe('itemOccursOn', ...)` covering at minimum:
- activity with `scheduled_at` on the date → true; different date → false.
- flight departing yesterday but arriving today → true.
- accommodation with checkin before / checkout after the date → true;
  date after checkout → false; checkin-only (no checkout) on its own date.
- dateless activity → false; dateless important note → true.

Optionally a TripTimeline render test following the `vi.mock('../api.js')`
pattern in `PendingReview.test.jsx`, asserting a stop with no today-items
disappears. If mocking TripTimeline's several api calls gets deep, the helper
unit tests plus manual verification are acceptable.

## Manual verification

Dev servers up (see README), create a trip with: an activity today, a flight
tomorrow, an accommodation spanning today. Toggle Today → only the activity and
accommodation show; toggle back → everything shows; empty-trip case shows the
empty state.

## Gotchas

- `StopCard` already internally filters/sorts `stop.items` — pass filtered
  items in, don't fight its internals.
- Weather fetching in StopCard keys off stop lat/lng and dates — unchanged
  stops props means no extra API traffic; passing a modified stop object is
  fine (same fields).
- Don't forget the build/amend push workflow — this touches `frontend/src/`.
