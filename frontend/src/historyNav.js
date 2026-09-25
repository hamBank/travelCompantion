// Browser Back/Forward inside the app (plan 18, D1). No router, no URL
// changes — this module just mirrors "what is on screen" into
// history.pushState/replaceState so Back/Forward feel native, and hands
// popped state back to the caller (App.jsx) to apply. No React here.
//
// See docs/plans/plan-18-browser-history.md (D1-D8) and
// docs/plans/plan-18a-history-shell.md for the shape and behaviour this
// implements.

import { snapshotToPath } from './urlPath.js'

export const SNAPSHOT_VERSION = 1

// The entry the app boots on — trip list, nothing open. Anything opening a
// trip at boot (TripList's auto-open / navState.js's restore) pushes on top
// of this, so the list is always the Back-stop underneath (D6).
export function rootSnapshot() {
  return {
    v: SNAPSHOT_VERSION,
    tripId: null,
    mode: 'timeline',
    day: null,
    calView: null,
    planning: false,
    overlay: null,
    item: null,
  }
}

function withVersion(snapshot) {
  return { ...snapshot, v: SNAPSHOT_VERSION }
}

function sameOverlay(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind
}

function sameItem(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.id === b.id && !!a.edit === !!b.edit
}

// Deep-equal on the D2 fields only — used so a push/replace that would
// write an identical entry (e.g. an effect firing twice) is a no-op instead
// of piling up dead history entries.
export function isSameNav(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.tripId === b.tripId &&
    a.mode === b.mode &&
    a.day === b.day &&
    a.calView === b.calView &&
    !!a.planning === !!b.planning &&
    sameOverlay(a.overlay, b.overlay) &&
    sameItem(a.item, b.item)
  )
}

// history.state if it's one of ours (v:1); null for a foreign entry (a page
// from before the app was opened, or the very first load before boot's
// replaceNav(rootSnapshot()) runs).
export function currentNav() {
  if (typeof window === 'undefined' || !window.history) return null
  const s = window.history.state
  return s && s.v === SNAPSHOT_VERSION ? s : null
}

// Opens a new Back-stop (D3): open a trip, change mode, enter/leave
// planning, open an overlay/item. No-ops if the resulting entry is
// identical to the current one.
export function pushNav(snapshot) {
  if (typeof window === 'undefined' || !window.history) return
  const next = withVersion(snapshot)
  if (isSameNav(currentNav(), next)) return
  window.history.pushState(next, '', snapshotToPath(next))
}

// Updates the current entry in place (D3): cycling a value (day, calendar
// view, item while a detail modal stays open, filters/theme). No-ops if
// identical to the current entry.
export function replaceNav(snapshot) {
  if (typeof window === 'undefined' || !window.history) return
  const next = withVersion(snapshot)
  if (isSameNav(currentNav(), next)) return
  window.history.replaceState(next, '', snapshotToPath(next))
}

// Every UI close/back affordance goes through this (D4) — never set state
// directly for a "close", or the popstate this triggers ends up fighting a
// dead entry left behind by doing both. Deliberately zero-arg: this is
// passed straight as `onClose={back}`/`onClick={back}` all over the app, so
// it must never do anything with a caller's argument — React would pass the
// SyntheticEvent as the first one, and `back` doing anything with it (even
// via a default parameter another call site relies on) breaks every one of
// those bindings silently (window.history.go(NaN) navigates nowhere). Use
// backSteps() below for the rare case of closing more than one layer.
export function back() {
  if (typeof window === 'undefined' || !window.history) return
  window.history.back()
}

// D4's documented history.go(-n) escape hatch for "closing something that
// isn't the top layer" — e.g. leaving a Today session that was entered by
// jumping to a day from the calendar: that pushed Today on top of a
// Calendar layer, so popping just one layer would surface Calendar again
// instead of the Timeline the action actually means. A separate export
// (not a `back(steps)` parameter) specifically so `back` itself stays safe
// to bind directly as an event handler — see its comment above. Always call
// this explicitly (`() => backSteps(2)`), never as a raw handler.
export function backSteps(n) {
  if (typeof window === 'undefined' || !window.history) return
  window.history.go(-n)
}

// --- Dirty-state guards (D5) ------------------------------------------------
// popstate can't be cancelled, so a guard runs *after* the fact: before the
// popped snapshot is applied, every registered guard runs in registration
// order; the first one to return false aborts — the module steps forward
// again (history.go(1)) to undo the navigation, and applies nothing.

const guards = []

export function registerNavGuard(fn) {
  guards.push(fn)
  return () => {
    const i = guards.indexOf(fn)
    if (i !== -1) guards.splice(i, 1)
  }
}

// history.go(1) (used to undo a cancelled pop) itself fires its own
// popstate later — this swallows that echo so it doesn't re-run guards or
// notify subscribers a second time.
let suppressNext = false

const popHandlers = new Set()

// Subscribes to popped navigation. `handler(snapshot)` is called with the
// popped entry's state, or `null` for a foreign entry (the browser should
// just be left to do whatever it would normally do — leave the app, in
// practice, since the app never pushes a foreign entry itself). Returns an
// unsubscribe function.
export function onPopNav(handler) {
  popHandlers.add(handler)
  return () => { popHandlers.delete(handler) }
}

function handlePopState(event) {
  if (suppressNext) { suppressNext = false; return }
  for (const guard of guards) {
    if (guard() === false) {
      suppressNext = true
      window.history.go(1)
      return
    }
  }
  const state = event.state
  const snapshot = state && state.v === SNAPSHOT_VERSION ? state : null
  for (const handler of popHandlers) handler(snapshot)
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', handlePopState)
}

// Number of push-layers a snapshot implies from the root (root = 0). Used
// for history.go(-n) in D4's rare "closing something that isn't the top
// layer" case.
export function layerDepth(snapshot) {
  if (!snapshot) return 0
  let depth = 0
  if (snapshot.tripId != null) depth += 1
  if (snapshot.mode && snapshot.mode !== 'timeline') depth += 1
  if (snapshot.planning) depth += 1
  if (snapshot.overlay) depth += 1
  if (snapshot.item) depth += 1
  if (snapshot.item && snapshot.item.edit) depth += 1
  return depth
}
