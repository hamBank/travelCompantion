# Plan 18b — History layers inside `TripTimeline`: day, item detail, edit

Read `docs/plans/README.md` first, then `docs/plans/plan-18-browser-history.md`
(D2–D5 apply). Depends on **18a** (`historyNav.js`, `applyNav`, the
`timelineRef` seam). Frontend only; two-commit build rule.

## Goal

Inside an open trip, Back closes the item edit modal, then the item detail
modal, then leaves Today mode — and Forward re-opens them. Changing day
(j/k, swipe, ‹ ›) and moving between items with j/k while a detail modal
is open update the current entry rather than stacking (D3).
`ItemEditModal`'s "Discard unsaved changes?" fires on Back too (D5).

## Files

- **`frontend/src/components/TripTimeline.jsx`**:
  - Receive the base snapshot from App via a small context
    (`NavBaseContext`, provided by `AppShell` with the current
    `snapshotFromState(...)` minus `day`/`item`) so the timeline can build
    full snapshots without knowing the shell's flags.
  - Opening a detail modal (`setNavItem(target)` from a card tap, and the
    calendar-hand-off path) → `pushNav({...base, day: selectedDay, item:
    {id, edit:false}})`. j/k `handleModalNav` → `replaceNav(...)` with the
    new item id. `closeNav` → `back()` (D4) — the actual `setNavItem(null)`
    and the scroll-to-item/day-jump behaviour it performs today move into
    `applyNav` (below) so they run on Back as well as ✕.
  - Edit from detail (`setEditItem(navItem)`) → `pushNav` with `edit:
    true`. `ItemEditModal`'s `onClose`/`onSave`/`onDeleted` → `back()`
    (save/delete also do their `load({background:true})` as today).
    `onDeleted` must go back **two** layers (edit + the detail modal of a
    now-deleted item): `history.go(-2)`.
  - Today mode: `selectedDay` changes from `navigateDay`/`shiftDay`/‹ › →
    `replaceNav({...base, day})`. Entering Today mode is App's push (18a);
    the first `setSelectedDay(initialDay || pickInitialDay(...))` after
    entry → `replaceNav` so the entry records the day.
  - `useImperativeHandle(ref, () => ({ applyNav(snapshot) }))` — sets
    `selectedDay` from `snapshot.day` (when `todayMode`), opens/closes the
    detail modal from `snapshot.item` (look the item up in
    `allItemsRef.current` by id; if it's not loaded yet — timeline still
    fetching — stash the id and apply after `load()` resolves; if the item
    no longer exists, `replaceNav` without `item`), and sets `editItem`
    from `snapshot.item?.edit`. Closing via snapshot performs the same
    scroll-to-`data-item-id` / day-jump that `closeNav` does today.
  - Guard: while `editItem` is set, register a nav guard that returns
    `true` when the edit form is clean, else `window.confirm('Discard
    unsaved changes?')` — the same text as `ItemEditModal`'s own close
    handler. The dirty check lives in `ItemEditModal` (`initialSnapshot`
    ref vs current form); expose it via an `isDirtyRef` prop the modal
    updates, so the guard doesn't duplicate the comparison.
  - `data-item-id` anchors and `navItemRef` stay as they are.
- **`frontend/src/components/ItemDetailModal.jsx` / `FlightDetailModal.jsx`
  / `RailDetailModal.jsx` and the other nav-registered detail modals** —
  their `onClose` props are already wired by `TripTimeline`; no change
  unless one calls `onClose` from a place that also sets local state (check
  `modalNav.js`'s `registerModal` users: the registered `closeFn` must be
  `back()`-based now).
- **`frontend/src/App.jsx`** — provide `NavBaseContext`; remove the 18a
  `applyNav` stub-forwarding comment; the calendar `onOpenItem` /
  `onOpenDay` hand-offs push a Today snapshot **with** `day` (and `item`
  for a chip tap once the "Later" item exists — not now).

## Behaviour checklist
- Timeline → tap a card → detail → Back → detail closed, card scrolled into
  view (same as ✕ today).
- Detail → Edit → Back → back to detail (not to the timeline). Back again
  → timeline.
- Detail → Edit → type a change → Back → "Discard unsaved changes?";
  Cancel → still editing with the typed change; OK → detail.
- Detail → j → j → Back → timeline (one entry per detail *open*, not per
  item).
- Today → swipe 5 days → Back → out of Today mode (D3).
- Today (day 3) → detail → Back → Today day 3 still selected.
- Forward after each of the above re-opens exactly what Back closed.
- Reload with a detail modal open → restored trip (navState) at the
  timeline (the modal is not restored — `navState` doesn't carry it; fine).

## Tests

`frontend/src/__tests__/TripTimeline.history.test.jsx` (mock `../api.js`
with a timeline fixture of 3 items; mock `../historyNav.js` for call
assertions; real `historyNav` + dispatched `popstate` for behaviour):
- Card tap → `pushNav` with `item:{id, edit:false}` and the current `day`.
- j/k in the modal → `replaceNav`, never `pushNav`.
- Modal ✕ → `back()` called, `setNavItem` not called directly; then
  `popstate` with the base snapshot closes the modal and the card's
  `data-item-id` element is scrolled (spy `scrollIntoView`).
- Edit → `pushNav` with `edit:true`; `onDeleted` → `history.go(-2)`.
- `applyNav({item:{id:2}})` before data loads → modal opens once data
  arrives; `applyNav` with an unknown id → `replaceNav` without `item`.
- Day change in Today mode → `replaceNav` with the new `day`; entering
  Today → the initial `replaceNav` records the picked day.
- Dirty edit + `popstate` → confirm; cancel → `history.go(1)`, form intact.

Extend `App.history.test.jsx`: calendar `onOpenDay` pushes
`{mode:'today', day}`.

Manual check: the behaviour checklist in Chrome device mode with the
browser Back/Forward buttons, plus keyboard j/k; note iOS swipe-back can't
be exercised in CI — say so in the PR body.

Run both suites; two-commit build; PR per `CLAUDE.md`.
