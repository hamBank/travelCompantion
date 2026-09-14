# Plan 16b — Calendar views: Day / Week / Month / Trip (read-only)

Read `docs/plans/README.md` first, then `docs/plans/plan-16-calendar.md`
(D1, D2, D3, D7, D9 apply here). Frontend only; follows the two-commit
build rule. No backend changes. Planning mode (drag) is **16d**, print is
**16c** — leave clear seams for both (noted below) but implement neither.

## Goal

From the hamburger menu, open a Google-Calendar-style view of the current
trip with four views: **Day** (delegates to the existing Today-mode day),
**Week** (7 columns, agenda-style), **Month** (7×n grid), **Trip** (7×n grid
covering the whole trip, first day → last day). Stops appear as coloured
multi-day bands; items as small kind-coloured chips on their day. Tapping a
chip opens the item's existing detail modal. Swipe left/right moves to the
next/previous period.

## Files

- **New `frontend/src/calendarModel.js`** — pure functions, no React:
  - `tripDateRange(timeline) -> {first: 'YYYY-MM-DD', last} | null` (D2).
  - `dayKeysBetween(first, last) -> string[]`.
  - `weeksCovering(first, last, weekStartsOn = 1) -> string[][]` — rows of 7
    day keys, Monday-first, padded so the first row starts on a Monday.
  - `stopBands(timeline) -> [{stop, first, last, colorIndex}]` — a stop
    with only `arrive` or only `depart` becomes a one-day band on that day;
    fully undated stops are omitted (listed separately, see UI).
  - `packLanes(bands) -> bands with .lane` — greedy interval colouring (D7).
  - `itemsByDay(timeline) -> Map<dayKey, item[]>` using **`itemDateKey`** and
    sorted by **`itemSortKey`** from `frontend/src/components/StopCard.jsx`
    (reuse, don't reimplement). Multi-day items (an accommodation
    `checkin → checkout`, an overnight flight) are placed on their **start**
    day only in this sub-plan; a span-rendering pass is a "later" item.
  - `shiftPeriod(view, anchorDay, ±1) -> newAnchorDay`.
- **New `frontend/src/components/TripCalendar.jsx`** — the view. Props:
  `timeline`, `view` (`'week'|'month'|'trip'`), `anchorDay`, `onOpenDay(day)`,
  `onOpenItem(item)`. Renders header row (weekday names), week rows, bands
  (absolutely positioned within each week row, `gridColumn: start / end`,
  lane → top offset), day cells with chips, "+N more" when a cell has more
  than ~4 chips, and a "Undated stops" strip under the grid when any exist.
  Today's cell gets an accent ring. Empty-state per D2.
- **`frontend/src/components/TripTimeline.jsx`** — add an optional
  `initialDay` prop: when set and `todayMode`, `setSelectedDay(initialDay)`
  instead of `pickInitialDay(timeline)` on first load. Nothing else changes.
- **`frontend/src/App.jsx`**:
  - new state `calendar` (boolean), `calendarView` (`'week'|'month'|'trip'`,
    persisted via a `getCalendarView/setCalendarView` pair added to
    `frontend/src/settings.js`, default `'trip'`), `calendarAnchor` (day key).
  - hamburger `MenuItem` **Calendar / Timeline** toggle mirroring Packing
    (sets `calendar`, clears `packing`/`editing`/`today`).
  - `main` renders `<TripCalendar …/>` when `calendar`. `onOpenDay(day)` →
    `setCalendar(false); setToday(true); setTodayInitialDay(day)` and pass
    it through as `initialDay`. `onOpenItem` → open the same nav-modal
    machinery `TripTimeline` uses (`handleModalNav`/`navItemRef` — read it;
    if lifting it is invasive, the acceptable fallback is `onOpenDay` on the
    item's day and let Today view handle the tap).
  - footer slot while `calendar`: segmented control **Day · Week · Month ·
    Trip** (Day = `onOpenDay(calendarAnchor)`), and ‹ › arrows. Leave a
    clearly marked spot for 16c's Print and 16d's Plan buttons.
  - `useSwipeNav` (`frontend/src/swipeNav.js`) with `enabled = calendar`,
    mapping next/prev → `shiftPeriod`. It's a document-level listener, so
    ensure the Today-mode one (`TripTimeline`) is not simultaneously
    enabled — it's gated on `todayMode`, which is false in calendar mode.
- **`frontend/src/index.css`** — `--stop-1 … --stop-8` per theme (dark
  default + latte/desert overrides next to the existing `--kind-*` blocks).
- **`frontend/src/api.js`** — no changes (D1).

## Rendering notes

- Month/Trip cell: date number top-left (muted; accent ring if today),
  bands across the top of the week row, chips below. Chip = kind colour dot
  + `itemTimeStr(item)` + name, one line, truncated. Mobile: chips show only
  the dot + time; name on `sm:` and up.
- Week view: same components with a single week row and taller cells so
  every chip fits (no "+N more").
- Trip view header shows "12 Sep – 3 Oct 2026 · 22 days"; Month shows the
  month name; Week shows the range.
- Sticky column header inside the scrollable grid. The grid, not the page,
  scrolls horizontally on very narrow screens (README: body never scrolls
  sideways — `index.css` sets `overflow-x: clip` on `html, body`).
- Respect `KindFilterContext` (`frontend/src/settings.js`) so the footer
  kind filter hides chips of other kinds, same as the timeline.
- Every hover-only control needs the `edit-btn` class (README convention 6).

## Tests

`frontend/src/__tests__/calendarModel.test.js`:
- `tripDateRange` widens with `start_date/end_date` but never narrows;
  null when nothing dated.
- `weeksCovering` pads to Monday; a range that starts on Sunday yields a
  first row with six leading pad days.
- `stopBands`: arrive-only → one-day; undated omitted; colour index cycles
  mod 8.
- `packLanes`: three overlapping → lanes 0,1,2; A(1–3) B(4–6) → both lane 0;
  overlap detection is inclusive of the end day.
- `itemsByDay` uses `itemDateKey` (a flight is on its `depart_time` day,
  not `scheduled_at`) and is sorted by `itemSortKey`.
- `shiftPeriod`: week ±7, month → first of next/prev month, trip → no-op.

`frontend/src/__tests__/TripCalendar.test.jsx` (vitest + testing-library,
`vi.mock('../api.js')` pattern from `PackingList.test.jsx`):
- Renders one band per dated stop with `gridColumn` spanning the right
  columns; a stop crossing a week boundary renders as two segments.
- Chip click calls `onOpenItem` with the item; date-number click calls
  `onOpenDay`.
- "+N more" appears when a day has > 4 chips.
- Empty timeline → empty-state text, no grid.

`frontend/src/__tests__/App.calendar.test.jsx`: the Calendar menu item
switches the main view and the footer shows the segmented control;
Day → Today mode with `initialDay` honoured (assert the selected day, not
`pickInitialDay`'s choice).

Spot-check in a real browser at phone width (README "Verifying UI
changes") before the build commit: a 3-week trip with an overlapping
side-trip stop, a hotel, two flights, in dark and a light theme.
