import { useState, useEffect, useRef } from 'react'
import { GoogleOAuthProvider } from '@react-oauth/google'
import TripList from './components/TripList.jsx'
import TripTimeline from './components/TripTimeline.jsx'
import EditTrip from './components/EditTrip.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import LoginPage from './components/LoginPage.jsx'
import UserSettings from './components/UserSettings.jsx'
import ShareModal from './components/ShareModal.jsx'
import SharedTripView from './components/SharedTripView.jsx'
import PendingReview from './components/PendingReview.jsx'
import PackingList from './components/PackingList.jsx'
import OfflineQueueBanner from './components/OfflineQueueBanner.jsx'
import BudgetSummary from './components/BudgetSummary.jsx'
import DistanceSummary from './components/DistanceSummary.jsx'
import DocumentsModal from './components/DocumentsModal.jsx'
import TravelersModal from './components/TravelersModal.jsx'
import MenuDropdown from './components/MenuDropdown.jsx'
import TripCalendar from './components/TripCalendar.jsx'
import { itemDateKey } from './components/StopCard.jsx'
import { shiftPeriod, emptyDraft, draftChangeCount, draftToRequest } from './calendarModel.js'
import { DEFAULT_THEME } from './themes.js'
import {
  getAuthConfig, exportTripPdf, getPending, getTripTimeline, refreshAuthToken, AUTH_EXPIRED_EVENT,
  rescheduleTrip, getDateWarnings, getTrip,
} from './api.js'
import { Menu, Backpack, Wallet, Inbox, FileText, Settings, CalendarDays, CalendarRange, Plane, Route, Printer, Users } from 'lucide-react'
import { canEdit, canManage } from './roles.js'
import { applyFontScale, KindFilterContext, getDefaultToToday, getCalendarView, setCalendarView as persistCalendarView } from './settings.js'
import { getSavedNav, saveNav, clearNav } from './navState.js'
import { useSwipeNav } from './swipeNav.js'
import { KIND_OPTIONS, KIND_LABEL } from './kinds.js'
import { useOnline } from './online.js'
import ItemEditModal from './components/ItemEditModal.jsx'
import { rootSnapshot, pushNav, replaceNav, back, backSteps, onPopNav, registerNavGuard } from './historyNav.js'
import { NavBaseContext } from './navContext.js'

// Apply saved font scale before first render
applyFontScale()

function useTheme() {
  const [theme, setThemeState] = useState(
    () => localStorage.getItem('tc-theme') || DEFAULT_THEME
  )
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('tc-theme', theme)
  }, [theme])
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
  return [theme, setThemeState]
}

function MenuItem({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ color: 'var(--text)' }}
      className="w-full text-left px-4 py-2.5 text-sm hover:opacity-80 transition-opacity disabled:opacity-50"
    >
      {children}
    </button>
  )
}

// Every overlay's `show*` flag, keyed to the snapshot `overlay.kind` it
// corresponds to (plan-18 D2). snapshotFromState below reads this list
// instead of a hand-written if/else chain specifically so a new overlay
// flag can't be added to AppShell's state without also appearing here —
// App.history.test.jsx asserts every flag in this object round-trips.
export const OVERLAY_KINDS = {
  showSettings: 'settings',
  showShare: 'share',
  showBudget: 'budget',
  showDistance: 'distance',
  showDocuments: 'documents',
  showTravelers: 'travelers',
  showImports: 'imports',
  showQuickAdd: 'quickAdd',
  showImportDoc: 'importDoc',
}

// Pure derivation of "what's on screen" (plan-18 D2) from AppShell's state —
// kept free of React so it's trivial to unit-test. Mode precedence mirrors
// how the JSX below picks a view: edit > packing > calendar > today >
// timeline. `day`/`item` are normally absent from AppShell's own state bag
// (TripTimeline owns those, 18b) and default to null — the one exception is
// the calendar's onOpenDay/onOpenItem hand-off, which passes `day` explicitly
// as an override so the Today snapshot it pushes records which day it jumped
// to (see handleOpenDay below). App only forwards a popped snapshot's
// day/item on to TripTimeline (applyNav below); it never reads them back out.
export function snapshotFromState(state) {
  const { selectedTrip, editing, packing, today, calendar, calendarView, planning, day, item } = state
  const mode = editing ? 'edit' : packing ? 'packing' : calendar ? 'calendar' : today ? 'today' : 'timeline'
  let overlay = null
  for (const flag of Object.keys(OVERLAY_KINDS)) {
    if (state[flag]) { overlay = { kind: OVERLAY_KINDS[flag] }; break }
  }
  return {
    v: 1,
    tripId: selectedTrip?.id ?? null,
    mode,
    day: day ?? null,
    calView: calendar ? (calendarView ?? null) : null,
    planning: !!planning,
    overlay,
    item: item ?? null,
  }
}

// Re-exported for convenience/discoverability — see navContext.js for why
// the context object itself lives there rather than being defined here.
export { NavBaseContext }

function AppShell({ user, onLogout }) {
  const [selectedTrip, setSelectedTrip] = useState(null)
  const [editing, setEditing] = useState(false)
  const [theme, setTheme] = useTheme()
  const [showSettings, setShowSettings] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [stats, setStats] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [showImports, setShowImports] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [tripStops, setTripStops] = useState([])
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [kindFilter, setKindFilter] = useState('')
  const [hidePacked, setHidePacked] = useState(false)
  const [packing, setPacking] = useState(false)
  const [today, setToday] = useState(false)
  const [todayInitialDay, setTodayInitialDay] = useState(null)
  // True when the current Today session was pushed directly from the trip
  // list (openTrip's own todayValue — the "open trips in Today view by
  // default" setting, or navState.js's restoreToday resuming a forced
  // reload/iOS-process-eviction that left off in Today mode) rather than
  // toggled on from an already-open Timeline. In that case there is no
  // Timeline entry underneath this trip's Today entry at all — only root
  // (the trip list) — so "All days" (below) must switch this entry to
  // Timeline in place instead of popping, which would overshoot straight
  // past the trip and land back on the trip list.
  const [todayEnteredDirect, setTodayEnteredDirect] = useState(false)
  const [calendar, setCalendar] = useState(false)
  const [calendarView, setCalendarViewState] = useState(getCalendarView)
  const [calendarAnchor, setCalendarAnchor] = useState(() => new Date().toLocaleDateString('sv-SE'))
  const [calendarTimeline, setCalendarTimeline] = useState(null)
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [calendarError, setCalendarError] = useState(null)
  const [showBudget, setShowBudget] = useState(false)
  const [showDistance, setShowDistance] = useState(false)
  const [showDocuments, setShowDocuments] = useState(false)
  const [showTravelers, setShowTravelers] = useState(false)
  const [showImportDoc, setShowImportDoc] = useState(false)
  // Planning mode (plan-16d): `planning` gates the calendar into editable
  // bands; `draft` accumulates unsaved moves/creates/deletes (calendarModel.js
  // — nothing here ever hits the network until Save, plan-16 D10). `saving`/
  // `saveConflict` cover the reschedule POST's in-flight/409 states;
  // `dateWarnings`/`undo` are post-Save UI (the warnings panel and the
  // one-shot Undo toast).
  const [planning, setPlanning] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [saveConflict, setSaveConflict] = useState(null) // {conflicts, current} from a 409
  const [dateWarnings, setDateWarnings] = useState(null) // {warnings:[...]} shown after a successful Save
  const [undo, setUndo] = useState(null) // {inverse, lossy} while the ~10s Undo toast is up
  const online = useOnline()

  // History (plan-18a/18b): timelineRef is the seam onto TripTimeline's own
  // internal layers (day/item/edit) — App forwards every popped snapshot to
  // it via timelineRef.current.applyNav(snapshot); TripTimeline owns what
  // that does with day/item. applyingRef is set while applyNav (below) is
  // running a popped snapshot's state changes, so the explicit push/replace
  // calls at each action site (openTrip, mode toggles, etc.) can't fire
  // again in response to state a pop already caused — those calls are all
  // driven directly by user actions, never by a generic effect watching
  // state, but this is a cheap belt-and-braces guard against that pattern
  // creeping back in later. tripNavLoading covers the gap while applyNav
  // fetches a trip a snapshot names that isn't already held in state.
  const timelineRef = useRef(null)
  const applyingRef = useRef(false)
  const [tripNavLoading, setTripNavLoading] = useState(false)

  function refreshPending() {
    if (online) getPending().then(p => setPendingCount(p.length)).catch(() => {})
  }
  useEffect(() => { refreshPending() }, [online])

  // Poll for new pending imports every 60 s so email arrivals surface without a reload.
  const pendingTimerRef = useRef(null)
  useEffect(() => {
    if (!online) return
    pendingTimerRef.current = setInterval(refreshPending, 60_000)
    return () => clearInterval(pendingTimerRef.current)
  }, [online])

  async function handleExportPdf() {
    if (!selectedTrip || exporting) return
    setExporting(true)
    try { await exportTripPdf(selectedTrip.id, selectedTrip.name) }
    catch (e) { alert(e.message) }
    finally { setExporting(false) }
  }

  // A plain Today toggle (footer button, or the setting on trip-open) should
  // fall back to TripTimeline's own pickInitialDay — only a jump FROM the
  // calendar (onOpenDay/onOpenItem below) should override it. Clearing this
  // whenever Today turns off, from whatever caused it, keeps a stale day from
  // a previous calendar jump from silently winning the next plain toggle.
  useEffect(() => { if (!today) { setTodayInitialDay(null); setTodayEnteredDirect(false) } }, [today])

  function setCalendarViewPersisted(view) {
    persistCalendarView(view); setCalendarViewState(view)
    replaceSnapshot({ calendarView: view }) // cycling the view replaces, doesn't stack (D3)
  }

  // Calendar view fetches its own copy of the timeline — TripTimeline already
  // owns the fetch/warnings/backfill lifecycle for its own view and doesn't
  // surface the raw payload upward, so the calendar (a separate, simpler
  // read-only consumer per plan-16 D1) fetches independently rather than
  // threading that state through App.
  useEffect(() => {
    if (!calendar || !selectedTrip) { setCalendarTimeline(null); setCalendarError(null); return }
    let cancelled = false
    setCalendarLoading(true); setCalendarError(null)
    getTripTimeline(selectedTrip.id)
      .then(tl => { if (!cancelled) setCalendarTimeline(tl) })
      .catch(e => { if (!cancelled) { setCalendarTimeline(null); setCalendarError(e.message) } })
      .finally(() => { if (!cancelled) setCalendarLoading(false) })
    return () => { cancelled = true }
  }, [calendar, selectedTrip])

  // Calendar → Today-mode handoff: Day view doesn't exist as its own grid
  // (plan-16 D9) — it exits into the existing Today-mode day for that date.
  // A chip tap resolves to its item's placement day (itemDateKey, same rule
  // TripCalendar itself places chips by) and opens that day; falls back to
  // the calendar's own anchor day if the item has no placeable date.
  function handleOpenDay(day) { guardLeavePlanning(() => {
    const wasPlanning = planning
    setCalendar(false); setToday(true); setTodayInitialDay(day)
    const overrides = { calendar: false, today: true, planning: false, day }
    // Leaving Calendar+Planning in one click closes two push layers at once
    // (D3: mode and planning are separate layers) — replaceNav collapses
    // them into the new one in place rather than needing an async
    // history.go(-2) (see historyNav.js's layerDepth for the general case);
    // Back from Today then lands on the Calendar entry underneath, which is
    // still a perfectly valid prior state to land on.
    if (wasPlanning) replaceSnapshot(overrides); else pushSnapshot(overrides)
  }) }
  function handleOpenItem(item) { handleOpenDay(itemDateKey(item) || calendarAnchor) }
  function shiftCalendar(direction) {
    setCalendarAnchor(a => shiftPeriod(calendarView, a, direction === 'next' ? 1 : -1))
  }

  // Print (plan-16c): Week/Trip read better landscape (agenda rows / a long
  // date range), Month better portrait (a near-square grid) — see the named
  // `@page landscape` rule in index.css that `.print-landscape` on <html>
  // switches on. `afterprint` (fired for both the real dialog and a
  // cancelled one) is the only reliable place to remove it again; a
  // setTimeout after calling print() can't be trusted to run after the
  // (blocking, in most browsers) print dialog closes.
  function handlePrintCalendar() {
    const root = document.documentElement
    const landscape = calendarView === 'week' || calendarView === 'trip'
    if (landscape) root.classList.add('print-landscape')
    const cleanup = () => {
      root.classList.remove('print-landscape')
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    window.print()
  }

  // Swipe navigation for the calendar (the touch analogue of the ‹ › arrows)
  // — mirrors TripTimeline's own useSwipeNav(navigateDay, todayMode), gated
  // so only one of the two document-level listeners is ever enabled at once
  // (todayMode is false while calendar is true, and vice versa).
  useSwipeNav(shiftCalendar, calendar)

  // Unsaved-draft guard (plan-16d): a non-empty draft must not be silently
  // discarded by navigating away or closing the tab. `beforeunload` covers
  // the tab-close/reload case; `guardLeavePlanning` covers every in-app exit
  // (leaving calendar mode, switching trips, going back to the trip list) —
  // wrap the specific state-changing action in it rather than trying to gate
  // every possible `setCalendar`/`setSelectedTrip` call site.
  const changeCount = draftChangeCount(draft)
  useEffect(() => {
    if (!planning || changeCount === 0) return
    function onBeforeUnload(e) { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [planning, changeCount])

  function guardLeavePlanning(action) {
    if (planning && changeCount > 0) {
      if (!window.confirm(`Discard ${changeCount} unsaved planning change${changeCount > 1 ? 's' : ''}?`)) return
    }
    if (planning) { setPlanning(false); setDraft(emptyDraft()) }
    action()
  }

  // Same guard, reused on the Back path (plan-18 D5): registered only while
  // there's actually something to lose, so a plain Back with nothing
  // pending never hits a confirm. Re-registers whenever planning/changeCount
  // change so the message always has the current count.
  useEffect(() => {
    if (!planning || changeCount === 0) return
    return registerNavGuard(() =>
      changeCount === 0 || window.confirm(`Discard ${changeCount} unsaved planning change${changeCount > 1 ? 's' : ''}?`)
    )
  }, [planning, changeCount])

  // --- History wiring (plan-18a) --------------------------------------------
  // snapshotFromState needs the full bag of state it derives a snapshot
  // from; pushSnapshot/replaceSnapshot apply `overrides` on top of the
  // *current* values (read directly from the render closure, not from a
  // setState callback) since the action sites below call these in the same
  // synchronous block as the setState calls that will produce that state —
  // by the time a pop could re-render with it, applyingRef is what stops a
  // second push/replace, not a dependency on the new state having committed.
  function currentStateBag() {
    return {
      selectedTrip, editing, packing, today, calendar, calendarView, planning,
      showSettings, showShare, showBudget, showDistance, showDocuments,
      showTravelers, showImports, showQuickAdd, showImportDoc,
    }
  }
  function pushSnapshot(overrides) {
    if (applyingRef.current) return
    pushNav(snapshotFromState({ ...currentStateBag(), ...overrides }))
  }
  function replaceSnapshot(overrides) {
    if (applyingRef.current) return
    replaceNav(snapshotFromState({ ...currentStateBag(), ...overrides }))
  }

  function applyOverlay(kind) {
    setShowSettings(kind === 'settings')
    setShowShare(kind === 'share')
    setShowBudget(kind === 'budget')
    setShowDistance(kind === 'distance')
    setShowDocuments(kind === 'documents')
    setShowTravelers(kind === 'travelers')
    setShowImports(kind === 'imports')
    setShowQuickAdd(kind === 'quickAdd')
    setShowImportDoc(kind === 'importDoc')
  }

  // The root (tripId: null) branch of applyNav below — also reachable if a
  // trip a snapshot names 404s (the trip was deleted/unshared since this
  // entry was pushed). Mirrors the old goBack()'s state reset; overlay is
  // still taken from the snapshot since Settings/Documents are reachable
  // from the trip list too (D2's overlay isn't trip-scoped).
  function applyRootState(snapshot) {
    setSelectedTrip(null); setEditing(false); setPacking(false); setCalendar(false); setToday(false)
    setStats(null); setUserChoseList(true); setTripStops([]); setKindFilter(''); setHidePacked(false)
    setPlanning(false); setDraft(emptyDraft()); setSaveConflict(null)
    applyOverlay(snapshot.overlay?.kind ?? null)
    clearNav()
  }

  // Applies a popped (or restored) snapshot's full state in one batch (D1).
  // Never called from a user action directly — only from the popstate
  // subscription below — so it never pushes/replaces itself; it just sets
  // state to match what history already says is current.
  async function applyNav(snapshot) {
    applyingRef.current = true
    try {
      if (snapshot.tripId == null) {
        applyRootState(snapshot)
        timelineRef.current?.applyNav(snapshot)
        return
      }
      if (!selectedTrip || selectedTrip.id !== snapshot.tripId) {
        setTripNavLoading(true)
        let trip
        try {
          trip = await getTrip(snapshot.tripId)
        } catch {
          // The trip this entry names is gone (deleted, unshared) or
          // unreachable — fall back to the root rather than get stuck on a
          // spinner for a trip that will never load.
          setTripNavLoading(false)
          const root = rootSnapshot()
          replaceNav(root)
          applyRootState(root)
          timelineRef.current?.applyNav(root)
          return
        }
        setTripNavLoading(false)
        setSelectedTrip(trip)
      }
      setEditing(snapshot.mode === 'edit')
      setPacking(snapshot.mode === 'packing')
      setCalendar(snapshot.mode === 'calendar')
      setToday(snapshot.mode === 'today')
      setPlanning(!!snapshot.planning)
      // Leaving planning (via Back, or Forward landing somewhere that isn't
      // planning) discards the draft — same as guardLeavePlanning's direct
      // paths; the confirm already happened (the registered guard above, or
      // this pop wouldn't have been allowed through).
      if (!snapshot.planning) { setDraft(emptyDraft()); setSaveConflict(null) }
      applyOverlay(snapshot.overlay?.kind ?? null)
      if (snapshot.calView) setCalendarViewState(snapshot.calView)
      timelineRef.current?.applyNav(snapshot)
    } finally {
      applyingRef.current = false
    }
  }

  // applyNav is recreated every render (it closes over selectedTrip etc.) —
  // keep a ref to the latest one so the popstate subscription (registered
  // once) never calls a stale closure.
  const applyNavRef = useRef(() => {})
  useEffect(() => { applyNavRef.current = applyNav })

  // Boot: claim the entry we start on as ours (D6) before anything else can
  // push. TripList's auto-open / navState.js's restore both go through
  // openTrip below, which pushes — so the list stays underneath even on a
  // restored reload (D7).
  useEffect(() => { replaceNav(rootSnapshot()) }, [])

  useEffect(() => {
    return onPopNav(snapshot => {
      if (!snapshot) return // foreign entry (pre-app history) — let the browser leave
      applyNavRef.current(snapshot)
    })
  }, [])

  function refreshCalendarTimeline() {
    if (!selectedTrip) return Promise.resolve()
    return getTripTimeline(selectedTrip.id)
      .then(tl => setCalendarTimeline(tl))
      .catch(e => setCalendarError(e.message))
  }

  async function handleSavePlan() {
    if (!selectedTrip || saving) return
    setSaving(true); setSaveConflict(null)
    const request = draftToRequest(draft, calendarTimeline?.stops || [])
    try {
      const response = await rescheduleTrip(selectedTrip.id, request)
      setPlanning(false)
      setDraft(emptyDraft())
      back() // planning's push layer is closing either way (D4) — same as Discard/a popped Back
      await refreshCalendarTimeline()
      try {
        const w = await getDateWarnings(selectedTrip.id)
        if (w?.warnings?.length) setDateWarnings(w)
      } catch { /* non-fatal — Save already succeeded */ }
      setUndo({ inverse: response.inverse, lossy: response.undo_lossy })
      setTimeout(() => setUndo(u => (u?.inverse === response.inverse ? null : u)), 10_000)
    } catch (e) {
      if (e.status === 409 && e.detail?.conflicts) setSaveConflict(e.detail)
      else alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  function handleDiscardPlan() {
    if (changeCount > 0 && !window.confirm(`Discard ${changeCount} unsaved planning change${changeCount > 1 ? 's' : ''}?`)) return
    setPlanning(false); setDraft(emptyDraft()); setSaveConflict(null)
    back() // this button IS the "close the planning layer" affordance (D4)
  }

  async function handleUndoPlan() {
    if (!selectedTrip || !undo) return
    const { inverse } = undo
    setUndo(null)
    try {
      await rescheduleTrip(selectedTrip.id, inverse)
      await refreshCalendarTimeline()
    } catch (e) {
      alert(`Undo failed: ${e.message}`)
    }
  }

  const [userChoseList, setUserChoseList] = useState(false)

  // Read once, at boot — whatever was open just before the app was last
  // reloaded (see main.jsx's update banner and navState.js).
  const savedNavRef = useRef(getSavedNav())

  // The "open in Today view by default" setting is an explicit, persistent
  // user preference — it must win over restoreToday (navState.js's "resume
  // exactly where a forced reload/process-eviction interrupted you", which
  // is otherwise saved on every trip open and would silently pin the app to
  // whatever view mode happened to be active last time, defeating the
  // setting on nearly every subsequent open).
  function openTrip(trip, todayOverride) { guardLeavePlanning(() => {
    const todayValue = getDefaultToToday() || (todayOverride ?? false)
    const wasPlanning = planning
    setSelectedTrip(trip); setEditing(false); setPacking(false); setCalendar(false); setToday(todayValue); setTodayEnteredDirect(todayValue); setStats(null); setTripStops([]); setKindFilter(''); setHidePacked(false)
    // Opening a trip is always a push (D3/D6) — TripList's auto-open and
    // navState.js's restore both call this too, so the list is always
    // underneath. If planning was dirty (switching trips out from under an
    // unsaved draft), collapse rather than stack a redundant layer — same
    // reasoning as handleOpenDay above.
    const overrides = { selectedTrip: trip, editing: false, packing: false, calendar: false, today: todayValue, planning: false }
    if (wasPlanning) replaceSnapshot(overrides); else pushSnapshot(overrides)
  }) }

  // Keep the last-open trip/view-mode saved so a forced reload can restore
  // it instead of dumping the user back at the trip list.
  useEffect(() => {
    if (selectedTrip) saveNav({ tripId: selectedTrip.id, today })
  }, [selectedTrip, today])

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {!online && (
        <div
          data-print-hide
          className="w-full text-center text-xs py-1.5 px-4"
          style={{ background: 'var(--warning)', color: '#1e1e2e', fontWeight: 500 }}
        >
          Offline — read-only
        </div>
      )}
      <div data-print-hide>
        <OfflineQueueBanner onLogout={onLogout} />
      </div>

      <header
        className="pr-3 sm:px-6 flex items-center gap-2 sticky top-0 z-20"
        style={{
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border)',
          // Standalone-PWA iOS draws the page under the status bar / camera
          // cutout (viewport-fit=cover + black-translucent in index.html) --
          // env(safe-area-inset-top) clears that. No cushion beyond the
          // inset itself (real-world feedback, three rounds: "too much
          // space" -> 0.2rem -> "could still move higher" -> 0.05rem ->
          // confirmed-deployed but still no visible movement -- a 2.4px
          // trim genuinely isn't perceptible, so this goes to the true
          // floor rather than shaving fractions of a px again).
          // Inline, not index.css: Tailwind utility classes are class
          // selectors and always beat an index.css element-selector rule —
          // see the note by the `main` safe-area rule there.
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: '0.1rem',
          // Left padding is deliberately bigger than the right side (and set
          // here, not via a px-3 class) to clear iOS Safari's edge-swipe
          // "go back in page history" gesture zone (~20pt from the true
          // screen edge). overscroll-behavior-x (index.css) only stops the
          // page's own rubber-band bounce, not that system gesture, so the
          // back button below must sit outside the zone itself or taps on it
          // get eaten by the OS gesture recognizer instead of firing click.
          paddingLeft: 'calc(env(safe-area-inset-left) + 1.25rem)',
        }}
      >
        {selectedTrip ? (
          <>
            <button
              onClick={back}
              aria-label="Back to trip list"
              style={{ color: 'var(--text-faint)' }}
              className="text-sm hover:opacity-70 transition-opacity shrink-0 -my-2 py-2 pr-2"
            >
              ←
            </button>
            <h1 style={{ color: 'var(--accent)' }} className="font-semibold text-xs truncate shrink min-w-0">
              {selectedTrip.name}
            </h1>
            {!editing && stats && (
              <span style={{ color: 'var(--text-faint)' }} className="text-xs shrink-0 whitespace-nowrap">
                {stats.total} stops · {stats.completed} completed
              </span>
            )}
          </>
        ) : (
          <h1 style={{ color: 'var(--accent)' }} className="font-semibold text-sm">
            <Plane size={16} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Travel Companion
          </h1>
        )}

        <div className="flex-1" />

        {user && (
          <MenuDropdown
            trigger={
              user.picture
                ? <img src={user.picture} alt={user.name} className="w-6 h-6 rounded-full" />
                : <span style={{ color: 'var(--text-faint)' }} aria-label="Menu"><Menu size={20} aria-hidden="true" /></span>
            }
          >
            {selectedTrip && online && canEdit(selectedTrip.role) && (
              <MenuItem onClick={() => {
                if (editing) { back(); return } // Edit -> View closes the Edit layer (D4)
                // Edit is its own mode, reachable from any other mode (Today,
                // Packing, Calendar) — not just Timeline — so jumping into it
                // clears whichever of those was active, same as every other
                // mode-switch menu item already does.
                guardLeavePlanning(() => {
                  setEditing(true); setPacking(false); setToday(false); setCalendar(false)
                  pushSnapshot({ editing: true, packing: false, today: false, calendar: false, planning: false })
                })
              }}>
                {editing ? 'View' : 'Edit'}
              </MenuItem>
            )}
            {selectedTrip && (
              <MenuItem onClick={() => {
                if (packing) { back(); return } // Packing -> Timeline closes the Packing layer (D4)
                guardLeavePlanning(() => {
                  setPacking(true); setEditing(false); setToday(false); setCalendar(false)
                  pushSnapshot({ packing: true, editing: false, today: false, calendar: false, planning: false })
                })
              }}>
                <Backpack size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />{packing ? 'Timeline' : 'Packing'}
              </MenuItem>
            )}
            {selectedTrip && (
              <MenuItem onClick={() => {
                if (calendar) { back(); return } // Calendar -> Timeline closes the Calendar layer (D4)
                guardLeavePlanning(() => {
                  setCalendar(true); setPacking(false); setEditing(false); setToday(false)
                  pushSnapshot({ calendar: true, packing: false, editing: false, today: false, planning: false })
                })
              }}>
                <CalendarRange size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />{calendar ? 'Timeline' : 'Calendar'}
              </MenuItem>
            )}
            {selectedTrip && online && canManage(selectedTrip.role) && (
              <MenuItem onClick={() => { setShowShare(true); pushSnapshot({ showShare: true }) }}>Share</MenuItem>
            )}
            {selectedTrip && (
              <MenuItem onClick={() => { setShowTravelers(true); pushSnapshot({ showTravelers: true }) }}>
                <Users size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Travelers
              </MenuItem>
            )}
            {selectedTrip && online && (
              <MenuItem onClick={handleExportPdf} disabled={exporting}>
                {exporting ? 'Exporting…' : 'Export PDF'}
              </MenuItem>
            )}
            {selectedTrip && online && !packing && (
              <MenuItem onClick={() => { setShowBudget(true); pushSnapshot({ showBudget: true }) }}><Wallet size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Budget</MenuItem>
            )}
            {selectedTrip && online && !packing && (
              <MenuItem onClick={() => { setShowDistance(true); pushSnapshot({ showDistance: true }) }}><Route size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Distance</MenuItem>
            )}
            {online && pendingCount > 0 && (
              <MenuItem onClick={() => { setShowImports(true); pushSnapshot({ showImports: true }) }}>
                <span style={{ color: 'var(--warning)' }}><Inbox size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Imports ({pendingCount})</span>
              </MenuItem>
            )}
            <MenuItem onClick={() => { setShowDocuments(true); pushSnapshot({ showDocuments: true }) }}><FileText size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Documents</MenuItem>
            <MenuItem onClick={() => { setShowSettings(true); pushSnapshot({ showSettings: true }) }}><Settings size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Settings</MenuItem>
            <div className="px-4 py-2 flex flex-col gap-1.5 items-start">
              <span style={{ color: 'var(--text-muted)' }} className="text-sm">Theme</span>
              <ThemePicker current={theme} onChange={setTheme} />
            </div>
            <div style={{ borderTop: '1px solid var(--border)' }} className="mt-1 pt-1">
              <MenuItem onClick={onLogout}>
                <span title={user.email}>Sign out</span>
              </MenuItem>
            </div>
          </MenuDropdown>
        )}
      </header>

      {showSettings && <UserSettings onClose={back} />}
      {showDocuments && <DocumentsModal onClose={back} />}
      {showShare && selectedTrip && <ShareModal trip={selectedTrip} onClose={back} />}
      {showTravelers && selectedTrip && (
        <TravelersModal trip={selectedTrip} userEmail={user?.email} onClose={back} />
      )}

      {showBudget && selectedTrip && (
        <BudgetSummary
          trip={selectedTrip} stops={tripStops}
          canEdit={online && canEdit(selectedTrip.role)}
          onClose={back}
        />
      )}
      {showDistance && selectedTrip && (
        <DistanceSummary trip={selectedTrip} onClose={back} />
      )}
      {showImports && (
        <PendingReview
          onClose={() => { back(); refreshPending() }}
          onChanged={refreshPending}
        />
      )}

      <KindFilterContext.Provider value={kindFilter}>
      <main className="w-full px-4 sm:px-8 lg:px-16 pt-1.5 pb-6">
        {selectedTrip
          ? packing
            ? <PackingList
              tripId={selectedTrip.id} userEmail={user?.email}
              canEdit={online && canEdit(selectedTrip.role)}
              canQueueEdit={!online && canEdit(selectedTrip.role)}
              hidePacked={hidePacked}
            />
            : editing
              ? <EditTrip
                  trip={selectedTrip}
                  onTripRenamed={name => setSelectedTrip(t => ({ ...t, name }))}
                  onTripUpdated={fields => setSelectedTrip(t => ({ ...t, ...fields }))}
                />
              : calendar
                ? calendarLoading
                  ? <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading calendar…</p>
                  : calendarError
                    ? <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{calendarError}</p>
                    : <TripCalendar
                        timeline={calendarTimeline} view={calendarView} anchorDay={calendarAnchor}
                        onOpenDay={handleOpenDay} onOpenItem={handleOpenItem}
                        planning={planning} draft={draft} onDraftChange={setDraft}
                      />
                : <NavBaseContext.Provider value={snapshotFromState(currentStateBag())}>
                    <TripTimeline
                      ref={timelineRef}
                      tripId={selectedTrip.id} onStats={setStats} onStops={setTripStops}
                      todayMode={today} initialDay={todayInitialDay}
                      onExitToday={() => setToday(false)}
                      importing={showImportDoc} setImporting={back}
                    />
                  </NavBaseContext.Provider>
          : tripNavLoading
            // A Back/Forward/reload-restore names a trip not already held in
            // state (applyNav, above) — show a spinner rather than let
            // TripList transiently mount and run its own auto-open (it
            // would race the fetch this is waiting on).
            ? <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading…</p>
            : <TripList onOpen={openTrip} skipAutoOpen={userChoseList}
                restoreTripId={savedNavRef.current?.tripId ?? null}
                restoreToday={savedNavRef.current?.today ?? false} />
        }
      </main>
      </KindFilterContext.Provider>

      {selectedTrip && calendar && saveConflict && (
        <div className="w-full px-4 sm:px-8 lg:px-16 py-2 text-xs" style={{ background: 'var(--surface-2)', borderTop: '1px solid var(--warning)' }}>
          <p style={{ color: 'var(--warning)' }} className="font-medium mb-1">
            Couldn't save — someone else changed "{saveConflict.current?.location ?? `stop #${saveConflict.current?.id}`}" at the same time. Your draft is kept — Discard and re-open Calendar to see the latest dates, then redo your changes.
          </p>
          <ul className="space-y-0.5">
            {(saveConflict.conflicts || []).map((f, i) => (
              <li key={i} style={{ color: 'var(--text-muted)' }}>
                {f.field}: yours "{f.mine}" vs. theirs "{f.server}"
              </li>
            ))}
          </ul>
          <button onClick={() => setSaveConflict(null)} style={{ color: 'var(--accent)' }} className="mt-1">Dismiss</button>
        </div>
      )}

      {selectedTrip && calendar && dateWarnings && (
        <div className="w-full px-4 sm:px-8 lg:px-16 py-2 text-xs" style={{ background: 'var(--surface-2)', borderTop: '1px solid var(--border)' }}>
          <p style={{ color: 'var(--text-muted)' }} className="font-medium mb-1">
            {dateWarnings.warnings.length} warning{dateWarnings.warnings.length > 1 ? 's' : ''} after this change
          </p>
          <ul className="space-y-0.5">
            {dateWarnings.warnings.map((w, i) => (
              <li key={i} style={{ color: 'var(--text-faint)' }}>{typeof w === 'string' ? w : w.message}</li>
            ))}
          </ul>
          <button onClick={() => setDateWarnings(null)} style={{ color: 'var(--accent)' }} className="mt-1">Dismiss</button>
        </div>
      )}

      {undo && (
        <div className="w-full px-4 sm:px-8 lg:px-16 py-2 text-xs flex items-center gap-3 justify-center" style={{ background: 'var(--surface-2)', borderTop: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text-muted)' }}>
            Plan saved{undo.lossy ? ' — deleted stops can\'t be restored' : ''}.
          </span>
          <button onClick={handleUndoPlan} style={{ color: 'var(--accent)' }} className="font-medium">
            Undo
          </button>
        </div>
      )}

      <footer className="w-full px-4 sm:px-8 lg:px-16 pb-8 pt-4 flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap justify-center">
          {selectedTrip && online && !packing && !calendar && (
            <button
              onClick={() => {
                if (today) {
                  // "All days" closes the Today layer (D4) — normally just
                  // one pop, back to Timeline. But a Today session entered by
                  // jumping to a day from the calendar (handleOpenDay) sits
                  // on top of a Calendar layer, not Timeline directly — a
                  // single pop would surface the Calendar grid instead (where
                  // Edit is equally unavailable, so this looked like Edit had
                  // vanished for good). todayInitialDay is non-null only for
                  // that jump (and is cleared whenever Today turns off, see
                  // above), so it's exactly the signal for "skip the Calendar
                  // layer too and land straight on Timeline."
                  if (todayInitialDay != null) { backSteps(2); return }
                  // A trip opened straight into Today (the "open trips in
                  // Today view by default" setting, or navState.js's
                  // restoreToday resuming a reload/iOS-eviction that left off
                  // in Today mode) has no Timeline entry underneath it at all
                  // — only the trip list. Popping there would land the user
                  // back on the trip list instead of this trip's Timeline,
                  // which isn't what "All days" means. Switch this entry to
                  // Timeline in place instead of popping past it.
                  if (todayEnteredDirect) {
                    setToday(false)
                    replaceSnapshot({ today: false })
                    return
                  }
                  back()
                  return
                }
                setToday(true); setEditing(false); setCalendar(false)
                pushSnapshot({ today: true, editing: false, calendar: false })
              }}
              style={{
                background: today ? 'var(--accent)' : 'transparent',
                color: today ? 'var(--accent-fg)' : 'var(--text-muted)',
                border: '1px solid',
                borderColor: today ? 'var(--accent)' : 'var(--border)',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              <CalendarDays size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />{today ? 'All days' : 'Today'}
            </button>
          )}
          {selectedTrip && calendar && (
            <div className="flex items-center gap-1.5">
              <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                <button
                  onClick={() => handleOpenDay(calendarAnchor)}
                  style={{ background: 'transparent', color: 'var(--text-muted)' }}
                  className="px-2.5 py-1.5 text-xs font-medium hover:opacity-80 transition-opacity"
                >
                  Day
                </button>
                {[['week', 'Week'], ['month', 'Month'], ['trip', 'Trip']].map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setCalendarViewPersisted(v)}
                    style={{
                      background: calendarView === v ? 'var(--accent)' : 'transparent',
                      color: calendarView === v ? 'var(--accent-fg)' : 'var(--text-muted)',
                    }}
                    className="px-2.5 py-1.5 text-xs font-medium hover:opacity-80 transition-opacity"
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => shiftCalendar('prev')}
                disabled={calendarView === 'trip'}
                aria-label="Previous period"
                style={{ color: 'var(--text-muted)' }}
                className="text-sm px-1.5 hover:opacity-70 transition-opacity disabled:opacity-30"
              >
                ‹
              </button>
              <button
                onClick={() => shiftCalendar('next')}
                disabled={calendarView === 'trip'}
                aria-label="Next period"
                style={{ color: 'var(--text-muted)' }}
                className="text-sm px-1.5 hover:opacity-70 transition-opacity disabled:opacity-30"
              >
                ›
              </button>
              {!planning && (
                <button
                  onClick={handlePrintCalendar}
                  aria-label="Print calendar"
                  style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
                >
                  <Printer size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Print
                </button>
              )}
              {selectedTrip && online && canEdit(selectedTrip.role) && (
                planning ? (
                  <div className="flex items-center gap-1.5">
                    <span style={{ color: 'var(--text-faint)' }} className="text-xs px-1">
                      {changeCount} change{changeCount === 1 ? '' : 's'}
                    </span>
                    <button
                      onClick={handleDiscardPlan}
                      disabled={saving}
                      style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity disabled:opacity-50"
                    >
                      Discard
                    </button>
                    <button
                      onClick={handleSavePlan}
                      disabled={saving}
                      style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setPlanning(true); setDraft(emptyDraft()); setSaveConflict(null); setDateWarnings(null)
                      pushSnapshot({ planning: true }) // entering planning is its own layer (D3)
                    }}
                    style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
                  >
                    Plan
                  </button>
                )
              )}
            </div>
          )}
          {selectedTrip && !editing && !packing && (
            <select
              value={kindFilter}
              onChange={e => setKindFilter(e.target.value)}
              aria-label="Filter by item kind"
              style={{
                background: kindFilter ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'transparent',
                color: kindFilter ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${kindFilter ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)'}`,
              }}
              className="px-2 py-1.5 rounded-lg text-xs font-medium outline-none cursor-pointer"
            >
              <option value="">All items</option>
              {KIND_OPTIONS.map(k => (
                <option key={k} value={k} style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          )}
          {selectedTrip && packing && (
            <select
              value={hidePacked ? 'hide' : 'all'}
              onChange={e => setHidePacked(e.target.value === 'hide')}
              aria-label="Show or hide packed items"
              title="Bags are always shown, even when their packed items are hidden"
              style={{
                background: hidePacked ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'transparent',
                color: hidePacked ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${hidePacked ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)'}`,
              }}
              className="px-2 py-1.5 rounded-lg text-xs font-medium outline-none cursor-pointer"
            >
              <option value="all" style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>All items</option>
              <option value="hide" style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>Hide packed</option>
            </select>
          )}
          {selectedTrip && !editing && !packing && !calendar && online && canEdit(selectedTrip.role) && (
            <button
              onClick={() => { setShowImportDoc(true); pushSnapshot({ showImportDoc: true }) }}
              style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              ⇪ Import from document
            </button>
          )}
          {selectedTrip && !editing && !calendar && online && canEdit(selectedTrip.role) && tripStops.length > 0 && (
            <button
              onClick={() => { setShowQuickAdd(true); pushSnapshot({ showQuickAdd: true }) }}
              style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              + Add item
            </button>
          )}
        </div>
        <div className="flex gap-4 justify-center" style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}>
          <a href="/privacy.html" style={{ color: 'var(--text-faint)' }} className="hover:underline">
            Privacy Policy
          </a>
          <a href="/tos.html" style={{ color: 'var(--text-faint)' }} className="hover:underline">
            Terms of Service
          </a>
          <a href="/coverage/" style={{ color: 'var(--text-faint)' }} className="hover:underline">Coverage</a>
          <span title="Loaded client build">build {typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev'}</span>
        </div>
      </footer>

      {showQuickAdd && (
        <ItemEditModal
          item={{ stop_id: tripStops[0]?.id, kind: 'activity', name: '', status: 'pending', details: {} }}
          isNew
          stops={tripStops}
          onSave={back}
          onClose={back}
        />
      )}
    </div>
  )
}

// This app has no client-side router at all — everything below decides what
// to render purely from React state (selectedTrip, editing, etc.), never
// from location.pathname. The public share link is the one exception: it
// must be reachable by a bare URL with no login, so it's the one place this
// app looks at the path directly. Kept as a separate top-level dispatch
// (rather than an early-return inside AuthenticatedApp) specifically so it
// stays outside the hooks in AuthenticatedApp below — an early return
// before useState/useEffect would violate the rules of hooks. The path
// itself is only ever read once at mount: this SPA never client-side-
// navigates between a normal session and a shared one (a real browser
// navigation reloads the page), so there's no scenario where this needs to
// react to the pathname changing under a mounted instance.
const SHARED_PATH_RE = /^\/shared\/([^/]+)\/?$/

export default function App() {
  const sharedMatch = typeof window !== 'undefined' ? window.location.pathname.match(SHARED_PATH_RE) : null
  if (sharedMatch) {
    return <SharedTripView token={sharedMatch[1]} />
  }
  return <AuthenticatedApp />
}

function AuthenticatedApp() {
  // A stored token means we already know the answer to "let this device in?"
  // regardless of what /auth/config says — so authReady/user start truthy
  // immediately instead of waiting on that network round-trip to settle.
  // Without this, every cold boot (online or off) blocked first paint behind
  // getAuthConfig()'s full request lifecycle before showing anything but a
  // blank screen, even for a returning user who was clearly already signed in.
  const hasStoredToken = !!localStorage.getItem('tc-token')
  const [authReady, setAuthReady] = useState(hasStoredToken)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [googleClientId, setGoogleClientId] = useState('')
  const [user, setUser] = useState(hasStoredToken ? { fromToken: true } : null)

  useEffect(() => {
    getAuthConfig()
      .then(cfg => {
        setAuthEnabled(cfg.enabled)
        setGoogleClientId(cfg.client_id)
        if (!cfg.enabled) {
          // No auth configured — go straight in
          setUser({ email: 'dev@local', name: 'Dev', picture: '' })
        } else if (!hasStoredToken) {
          // Check for existing token
          const token = localStorage.getItem('tc-token')
          if (token) setUser({ fromToken: true })
        }
      })
      .catch(() => {
        // Backend unreachable — allow offline access if a token exists
        if (!hasStoredToken) {
          const token = localStorage.getItem('tc-token')
          if (token) setUser({ fromToken: true })
        }
      })
      .finally(() => setAuthReady(true))
  }, [])

  function handleLogin(u) { setUser(u) }

  function handleLogout() {
    localStorage.removeItem('tc-token')
    setUser(null)
  }

  // Expired/invalidated session (any authed request came back 401, see
  // api.js) — sign out so the login page shows, rather than leaving the app
  // up with every request failing until the user finds Sign out themselves.
  useEffect(() => {
    if (!authEnabled) return
    const onExpired = () => handleLogout()
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
  }, [authEnabled])

  // Sliding session: refresh the stored JWT on boot and daily while the app
  // stays open (a phone PWA can stay "open" for weeks without rebooting the
  // page), so an actively-used session never hits the fixed JWT_EXPIRE_DAYS
  // cliff — it only expires after that long of not using the app at all.
  // Failures are ignored: offline is fine (next interval/boot retries), and
  // an actually-dead token 401s → the expiry handler above signs out.
  useEffect(() => {
    if (!authEnabled || !user) return
    const doRefresh = () => { refreshAuthToken().catch(() => {}) }
    doRefresh()
    const id = setInterval(doRefresh, 24 * 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [authEnabled, user])

  if (!authReady) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg)' }}
      />
    )
  }

  // Always the same GoogleOAuthProvider element at this tree position, even
  // before getAuthConfig() resolves and googleClientId is still '' — the
  // provider only stores clientId in context (GoogleLogin/etc. read it when
  // rendered) and doesn't need a real id to mount safely, so its own clientId
  // prop can just update once the real value arrives. Switching between
  // *rendering* the provider at all (clientId ? <Provider>...</Provider> :
  // bare) — as this used to — changes the element type at this position the
  // instant the config finishes loading, which unmounts AppShell entirely
  // and mounts a brand new one: for a returning user (authReady starts true
  // off a stored token, so AppShell is already up and has already
  // auto-opened a trip, pushing it to history) that meant losing all of
  // AppShell's state and getting a *second* auto-open pushed on top of a
  // history entry the first one had already claimed — corrupting the Back
  // stack right after every cold boot. Reported: "hitting the back button
  // after an initial load of the app, which defaults to the latest trip,
  // results in going back in the browser and exiting the app."
  return (
    <GoogleOAuthProvider clientId={googleClientId}>
      {(!authEnabled || user)
        ? <AppShell user={user} onLogout={authEnabled ? handleLogout : null} />
        : <LoginPage onLogin={handleLogin} />}
    </GoogleOAuthProvider>
  )
}
