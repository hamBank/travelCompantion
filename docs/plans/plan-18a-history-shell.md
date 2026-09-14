# Plan 18a — History module + App-shell layers

Read `docs/plans/README.md` first, then `docs/plans/plan-18-browser-history.md`
(D1–D8 are what this implements). Frontend only; two-commit build rule.
`TripTimeline`'s internal navigation (Today-mode day, item detail, edit) is
**18b** — leave a clean seam for it (below) but don't implement it here.

## Goal

Browser Back/Forward drive the App shell: trip list ↔ trip, the five modes,
planning on/off, and every overlay modal. Back at the trip list leaves the
app as before. The header ← and every modal's close go through the same
history path so the stack never drifts. Planning mode's unsaved-draft
confirm fires on Back too.

## Files

- **New `frontend/src/historyNav.js`** — no React:
  - `SNAPSHOT_VERSION = 1`, `rootSnapshot()`.
  - `pushNav(snapshot)`, `replaceNav(snapshot)` — `history.pushState/
    replaceState({...snapshot, v: 1}, '')` (URL untouched, D1). Both
    no-op identical consecutive snapshots (`isSameNav(a, b)` — deep-equal
    on the D2 fields) so an effect firing twice can't double-push.
  - `back()` → `history.back()`.
  - `currentNav()` → `history.state` if `v === 1`, else `null`.
  - `onPopNav(handler)` — subscribes to `popstate`; calls
    `handler(snapshot | null)` (`null` for a foreign entry, D2). Returns an
    unsubscribe.
  - `registerNavGuard(fn)` → unregister. Guards are run by the pop handler
    in registration order; the first returning `false` aborts the
    navigation and the module calls `history.go(1)` (D5). Because
    `history.go(1)` itself fires a `popstate`, set a module-level
    `suppressNext` flag so that echo is swallowed.
  - `layerDepth(snapshot)` — number of pushes from root implied by a
    snapshot (root 0; +1 trip; +1 non-timeline mode; +1 planning; +1
    overlay; +1 item; +1 item.edit), used for `history.go(-n)` in D4's
    rare parent-unmount case.
- **`frontend/src/api.js`** — `getTrip(id)` → `GET /trips/{id}`.
- **`frontend/src/App.jsx`**:
  - Derive the current snapshot from state with one pure function
    `snapshotFromState({selectedTrip, editing, packing, today, calendar,
    calendarView, planning, showSettings, …})` (mode precedence: edit >
    packing > calendar > today > timeline; overlay from the `show*`
    flags). Keep it next to the state so a new `show*` flag can't be
    forgotten — add a test that lists every `show*` state and asserts the
    function knows it.
  - One `applyNav(snapshot)` that sets **all** view state from a snapshot
    in a single batch: `tripId` null → `goBack()`'s body minus the
    `clearNav()`/history parts; `tripId` set and ≠ current → `getTrip(id)`
    then `setSelectedTrip(...)` (spinner state while fetching; on 404 fall
    back to the root snapshot with `replaceNav`); mode/planning/overlay
    flags set to exactly what the snapshot says (every other flag false).
    For 18b: also forward `snapshot.day` / `snapshot.item` to a
    `timelineRef.current?.applyNav(snapshot)` if present — a no-op until
    18b implements it.
  - Effect: whenever the derived snapshot changes because of a **user
    action**, push or replace per D3. Do this with explicit calls at the
    action sites (`openTrip` → push; mode toggles → push; `setShowX(true)`
    → push; `setCalendarViewPersisted` → replace; kind filter → nothing),
    **not** with a catch-all effect diffing state — an effect can't tell
    push from replace, and it would also fire when `applyNav` runs in
    response to a pop (which must not push again). Guard against that
    anyway: `applyNav` sets an `applyingRef` while it runs.
  - `goBack()` (header ←), every overlay's `onClose`, Today's "All days",
    Packing→Timeline, Calendar→Timeline, Edit→View: call `back()` (D4). A
    modal that closes itself after a successful action also calls
    `back()`. Where the same handler today also does cleanup (e.g.
    `PendingReview`'s `onClose` → `refreshPending()`), keep the cleanup in
    the handler and let the state change come from the pop.
  - Boot: `replaceNav(rootSnapshot())` once in `AppShell` mount. TripList's
    auto-open / restore path calls `openTrip` which pushes (D6).
  - Planning guard: `registerNavGuard(() => changeCount === 0 ||
    window.confirm(<the existing text>))` while `planning && changeCount
    > 0` (D5). The existing in-app guards in the Discard/leave handlers
    stay for their non-Back paths.
  - `onPopNav` subscription in `AppShell`: `null` → do nothing (foreign
    entry; browser leaves); else run `applyNav`.
- **`frontend/src/components/TripTimeline.jsx`** — only the seam:
  `forwardRef` + `useImperativeHandle(ref, () => ({ applyNav: () => {} }))`
  stub so 18b can fill it; App passes `ref={timelineRef}`.
- **`frontend/src/navState.js`** — unchanged (D7), but `goBack` no longer
  needs to call `clearNav()` itself: `applyNav` to the root does.

## Behaviour checklist (what "done" looks like in a browser)
- List → open trip → Back → list. Back again → leaves the app / closes PWA.
- Trip → Packing → Back → timeline. Forward → Packing again.
- Trip → Settings modal → Back → modal closed, trip still open.
- Trip → Calendar → Plan → make a change → Back → confirm dialog; Cancel
  → still planning with the draft intact; OK → calendar, draft gone.
- Calendar: switch Week→Month→Trip → one Back returns to the timeline (D3
  replace), not through each view.
- Reload while a trip is open → restored (navState) → Back → list.
- Long-press Back in Chrome shows the layers; picking "list" from three
  deep lands on the list with no modal remnants.

## Tests

`frontend/src/__tests__/historyNav.test.js` (jsdom has `history` and
`popstate`):
- push/replace write `v:1` state; identical consecutive push is a no-op;
  `currentNav()` returns null for foreign state.
- `onPopNav` delivers the entry's state; foreign entry → `null`.
- Guard returning `false` → handler not called and `history.go(1)` invoked
  (spy); the echoed `popstate` is swallowed; guard returning `true` →
  applied.
- `layerDepth` for root / trip / trip+packing / trip+overlay / trip+item
  +edit.

`frontend/src/__tests__/App.history.test.jsx` (`vi.mock('../api.js')`,
`vi.mock('../historyNav.js')` where asserting calls; real module where
asserting behaviour):
- Opening a trip calls `pushNav` with `{tripId, mode:'timeline'}`; boot
  called `replaceNav(root)` first.
- Header ← calls `back()` and does not itself change `selectedTrip`;
  dispatching `popstate` with the root snapshot then shows the list.
- Each mode toggle pushes; `setCalendarView` replaces.
- Each `show*` overlay pushes on open; its `onClose` calls `back()`.
- `applyNav` with a foreign trip id fetches `getTrip` and sets the role.
- Planning with a dirty draft: `popstate` → `window.confirm` called;
  cancel → `history.go(1)` and draft intact; OK → planning off.
- The "every `show*` flag is known to `snapshotFromState`" guard test.

Manual check (README "Verifying UI changes"): run through the behaviour
checklist in Chrome at phone width (device mode, use the browser Back
button) and desktop; note iOS swipe-back can't be exercised here — say so
in the PR body.

Run both suites; two-commit build; PR per `CLAUDE.md`.
