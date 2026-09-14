# Plan 18 — Browser Back/Forward that works inside the app

Read `docs/plans/README.md` first (conventions, test gates, build workflow).
This is the **parent** plan: it fixes the decisions both sub-plans share and
argues the "why" once. Each sub-plan is one PR, executable on its own by an
agent with no other context; they state these decisions without re-arguing.

| Sub-plan | Scope | Effort | Depends on |
|---|---|---|---|
| [plan-18a-history-shell.md](plan-18a-history-shell.md) | `historyNav.js` module; App-shell layers (trip list → trip → mode → overlay modals) mirrored into `history`; Back/Forward apply snapshots; header ← unified with browser Back; dirty guards for planning mode | M | — |
| [plan-18b-history-timeline.md](plan-18b-history-timeline.md) | Inside `TripTimeline`: Today-mode day, item detail modal, and detail → edit as history layers; `ItemEditModal`'s unsaved-changes guard honoured on Back | M | 18a |
| Later (see below) | Component-local nested modals (history, rail lookup); readable URL hash + deep links; shared view | — | 18b |

Recommended order: 18a, then 18b.

## Goal

The app is a state-driven SPA with **no router** — `App.jsx` says so
deliberately, and every view (trip list, an open trip, Today mode, Packing,
Edit, Calendar, Planning, every modal) is decided purely from React state.
Nothing ever calls `history.pushState`, so the browser's history for the
app is one entry. Pressing Back — the Android system button, iOS Safari's
edge swipe, the desktop button, a mouse side-button — therefore leaves the
app entirely (or, as a home-screen PWA with `display: standalone`, closes
it). After this plan: Back closes the topmost thing you opened (modal →
detail → day → trip → list), Forward re-opens it, and Back at the trip
list leaves the app exactly as it does today. Nothing else about the app's
navigation model changes.

## Decisions shared by both sub-plans (state, don't re-argue)

### D1. React state stays the source of truth; history *mirrors* it
No router library and no URL-driven state. A single module,
`frontend/src/historyNav.js`, wraps `history.pushState` /
`history.replaceState` / `popstate` and exposes `pushNav(snapshot)`,
`replaceNav(snapshot)`, `back()`, `onPopNav(handler)` and the guard
registry (D5). Every history entry's `state` is a small **serialisable
snapshot** of "what is on screen" (D2). On `popstate` the app **applies the
snapshot from `event.state`** — it does not guess "close whatever is open".
That is what makes Forward, multi-step Back (long-press menu) and reload
all behave. The URL itself does not change in this plan (see Later).

### D2. The snapshot shape (`v: 1`)
```js
{ v: 1,
  tripId: 12 | null,                 // null = trip list (the root)
  mode: 'timeline' | 'today' | 'packing' | 'edit' | 'calendar',
  day: 'YYYY-MM-DD' | null,          // Today mode only (18b)
  calView: 'week' | 'month' | 'trip' | null,
  planning: false,
  overlay: null | { kind: 'settings'|'share'|'budget'|'distance'|'documents'|'travelers'|'imports'|'quickAdd'|'importDoc' },
  item: null | { id: 88, edit: false }   // detail modal open on item 88; edit: true = ItemEditModal on top (18b)
}
```
Ids only — never the trip or item object. `selectedTrip` carries the
user's role, so applying a snapshot with a `tripId` the shell doesn't
currently hold means fetching `GET /trips/{id}` (`TripReadWithRole`;
18a adds `getTrip(id)` to `api.js`). Any entry whose `state` is not an
object with `v === 1` is **foreign** (a page before the app was opened) —
the handler does nothing and lets the browser leave.

### D3. What is a layer (push) and what is not (replace)
A **push** creates a Back-stop: open a trip; change mode
(timeline↔today↔packing↔edit↔calendar); enter/leave planning; open any
overlay modal; open an item's detail modal; open Edit from a detail modal.
A **replace** updates the current entry in place: changing the day in Today
mode (j/k, swipe, ‹ ›); changing the calendar period or view; j/k between
items while a detail modal is open; kind filter, hide-packed, theme. Rule of
thumb: Back should undo *opening something*, never step through every
value a control cycled through — a week of swiping days must not need a
week of Backs.

### D4. Every UI "close/back" affordance goes through `history.back()`
The header `←`, a modal's ✕ / backdrop tap / Escape, "Close" in a detail
modal, and Today-mode's "All days" all call `back()` from `historyNav.js`
when the thing they close is the top history layer, and the resulting
`popstate` performs the state change. They must **not** also set state
directly — doing both leaves a dead entry behind, and the next Back is a
confusing no-op. The one exception: a programmatic close that is *not*
navigation (a modal closing itself after a successful save) — that one
calls `back()` too, since the layer is gone either way. If an affordance
closes something that is *not* the top layer (rare; e.g. a parent
unmounting while a child modal is open) use `history.go(-n)` with `n`
computed from the layer depth — 18a's `layerDepth(snapshot)` helper.

### D5. Dirty-state guards, applied *after* the fact
`popstate` cannot be cancelled. The pattern: a component with unsaved
state registers a guard (`registerNavGuard(fn)` → returns unregister);
on `popstate`, before applying the snapshot, the handler runs the guards
top-down; if one returns `false` (user chose to stay), the handler calls
`history.go(1)` to step forward again and applies nothing. Guards reuse
the exact `window.confirm(...)` text already in the code so the message is
the same whether you tapped ✕ or pressed Back: planning mode's
`Discard N unsaved planning change(s)?` (`App.jsx`) and `ItemEditModal`'s
`Discard unsaved changes?`. `beforeunload` stays as-is for real page
unloads.

### D6. The root entry and leaving the app
On boot, `replaceNav({v:1, tripId:null, mode:'timeline', …})` so the
entry we start on is ours. Anything that opens a trip at boot — TripList's
"next upcoming" auto-open and `navState.js`'s restore-after-reload — is a
**push**, so the trip list is always underneath and Back from an auto-opened
trip goes to the list, not out of the app. At the list, Back leaves the app
(or closes the standalone PWA) — that is correct behaviour, and we never
push a dummy entry to trap the user.

### D7. Reload and iOS process eviction
`navState.js` remains the restore-after-reload mechanism (localStorage,
because a backgrounded iOS PWA can be killed and relaunched cold — its
comment explains). After restore, the current entry is `replaceNav`'d to
match what's on screen. Older entries in the stack from before the reload
still carry `v:1` snapshots and apply fine (ids are looked up fresh).

### D8. iOS Safari swipe-back
Today the edge swipe leaves the app; after this plan it navigates our
history, so it becomes "close the top layer". Known WebKit quirk: the
swipe preview is a screenshot of the *same* page (there is no other page),
which can look like a flicker — accepted, it is what every pushState SPA
does. The header's extra left inset that keeps the ← button out of the
edge-swipe zone (see `App.jsx`) stays as-is.

### D9. Scope guard
This plan does not add URL routing, deep links, or change the
`/shared/{token}` page (a single view with no in-app navigation). The
`SharedTripView` path is untouched.

## Later (deliberately not in 18a–18b)
- **Component-local nested modals** — `ItemHistoryModal` and
  `RailLookupModal` open from inside a detail/edit modal with their own
  state. Until they adopt a layer, Back closes the whole detail modal
  instead of just them; acceptable for now.
- **Readable URL hash** (`#/trips/12/today/2026-10-04`) mirroring the
  snapshot, then parsing it on boot → shareable deep links inside the app.
  D2's snapshot is designed so this is a pure serialisation change.
- **Calendar chip → detail modal** (plan 16 "Later") would get history for
  free once 18b lands.
