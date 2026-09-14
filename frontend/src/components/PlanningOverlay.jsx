import { useState, useRef, useEffect } from 'react'
import { cellFromPoint, dayKeyAt, daysBetweenDayKeys, shiftDateStr } from '../calendarModel.js'

// Pointer-event drag machinery for planning mode (plan-16d), per plan-16 D8:
// Pointer Events + setPointerCapture (not HTML5 drag-and-drop, which doesn't
// fire on touch in Safari without a polyfill), grid-geometry hit testing
// (cellFromPoint/dayKeyAt — never elementFromPoint), and a 300 ms long-press
// gate on touch so a scroll-flick over a band isn't mistaken for a drag.
//
// This component renders nothing of its own — TripCalendar.jsx already owns
// every pixel of the calendar's visuals (bands, chips, day cells), rendered
// from applyDraft() so they visibly reflect the draft. PlanningOverlay is
// mounted alongside that render tree purely to own the *gesture* state
// machine and hand TripCalendar a small set of prop-getters
// (bandGrabProps/bandHandleProps/emptyCellProps) to spread onto the DOM
// nodes it already renders, via the render-prop `children` function — so
// there is exactly one visual layer, and the pointer logic here is fully
// unit-testable against a minimal synthetic DOM (see
// frontend/src/__tests__/PlanningOverlay.test.jsx) without needing to stand
// up the whole calendar.
export const LONG_PRESS_MS = 300
export const MOVE_CANCEL_PX = 8

// currentDatesFor: a stop's arrive/depart as this drag should treat them —
// its draft move if one already exists this session (so dragging a band
// twice compounds correctly), else its original server values.
function currentDatesFor(draft, originalStops, stopId) {
  const move = draft?.moves?.[stopId]
  if (move) return { arrive: move.arrive ?? null, depart: move.depart ?? null }
  const orig = (originalStops || []).find(s => s.id === stopId)
  return { arrive: orig?.arrive ?? null, depart: orig?.depart ?? null }
}

export default function PlanningOverlay({
  weeks, originalStops, draft, onDraftChange, onCreateStop, onDeleteStop, rowHeight = 32, children,
}) {
  const gridRef = useRef(null)
  const [gesture, setGesture] = useState(null)
  const [focusedStopId, setFocusedStopId] = useState(null)
  const touchPending = useRef(null)

  // Escape cancels an in-progress drag with no draft change (D8's escape
  // hatch) — a window-level listener because focus during a drag may be
  // anywhere (the dragged element itself, or nowhere on touch).
  useEffect(() => {
    if (!gesture) return
    function onKey(e) { if (e.key === 'Escape') setGesture(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gesture])

  function cellAt(clientX, clientY) {
    const el = gridRef.current
    const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 7 * 40, height: rowHeight * Math.max(1, weeks.length) }
    const rh = weeks.length ? rect.height / weeks.length : rowHeight
    const { col, row } = cellFromPoint(rect, 7, rh, clientX, clientY)
    return dayKeyAt(weeks, { col, row })
  }

  function beginGesture(type, stopId, x, y) {
    const day = cellAt(x, y)
    const { arrive, depart } = stopId != null ? currentDatesFor(draft, originalStops, stopId) : { arrive: null, depart: null }
    setGesture({ type, stopId, origArrive: arrive, origDepart: depart, startDay: day, currentDay: day })
  }

  function applyMove(stopId, arrive, depart) {
    onDraftChange?.({ ...draft, moves: { ...(draft?.moves || {}), [stopId]: { arrive, depart } } })
  }

  function commitGesture(g) {
    if (!g.startDay) return
    if (g.type === 'create') {
      if (!g.currentDay) return
      const first = g.startDay <= g.currentDay ? g.startDay : g.currentDay
      const last = g.startDay <= g.currentDay ? g.currentDay : g.startDay
      onCreateStop?.(first, last)
      return
    }
    const delta = daysBetweenDayKeys(g.startDay, g.currentDay)
    if (delta === 0) return
    if (g.type === 'move') {
      const arrive = g.origArrive ? shiftDateStr(g.origArrive, delta) : g.origArrive
      const depart = g.origDepart ? shiftDateStr(g.origDepart, delta) : g.origDepart
      applyMove(g.stopId, arrive, depart)
    } else if (g.type === 'resize-end') {
      let depart = g.origDepart ? shiftDateStr(g.origDepart, delta) : g.origDepart
      if (g.origArrive && depart && depart < g.origArrive) depart = g.origArrive
      applyMove(g.stopId, g.origArrive, depart)
    } else if (g.type === 'resize-start') {
      let arrive = g.origArrive ? shiftDateStr(g.origArrive, delta) : g.origArrive
      if (g.origDepart && arrive && arrive > g.origDepart) arrive = g.origDepart
      applyMove(g.stopId, arrive, g.origDepart)
    }
  }

  function makePointerDown(type, stopId) {
    return (e) => {
      if (e.button != null && e.button !== 0) return
      try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* jsdom/older browsers */ }
      if (e.pointerType === 'touch') {
        const sx = e.clientX, sy = e.clientY
        const pending = { sx, sy, cancelled: false, timer: null }
        pending.timer = setTimeout(() => {
          if (pending.cancelled) return
          touchPending.current = null
          beginGesture(type, stopId, sx, sy)
        }, LONG_PRESS_MS)
        touchPending.current = pending
      } else {
        beginGesture(type, stopId, e.clientX, e.clientY)
      }
    }
  }

  function handlePointerMove(e) {
    if (touchPending.current) {
      const p = touchPending.current
      if (!p.cancelled) {
        const dx = Math.abs(e.clientX - p.sx), dy = Math.abs(e.clientY - p.sy)
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
          clearTimeout(p.timer)
          p.cancelled = true // a scroll, not a drag — the long-press never fires
        }
      }
      return
    }
    if (!gesture) return
    const day = cellAt(e.clientX, e.clientY)
    if (day && day !== gesture.currentDay) setGesture(g => (g ? { ...g, currentDay: day } : g))
  }

  function handlePointerUp() {
    if (touchPending.current) {
      clearTimeout(touchPending.current.timer)
      touchPending.current = null
      return
    }
    if (gesture) commitGesture(gesture)
    setGesture(null)
  }

  function handlePointerCancel() {
    if (touchPending.current) { clearTimeout(touchPending.current.timer); touchPending.current = null }
    setGesture(null) // no commit — same as Escape
  }

  // Keyboard access on a focused band (cheap accessibility win, and testable
  // without synthesising pointer geometry): ← → move ±1 day, Shift+← →
  // resizes the end (clamped so depart never precedes arrive), Delete/
  // Backspace removes the stop.
  function bandKeyDown(stopId) {
    return (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Delete' && e.key !== 'Backspace') return
      e.preventDefault()
      const { arrive, depart } = currentDatesFor(draft, originalStops, stopId)
      if (e.key === 'Delete' || e.key === 'Backspace') { onDeleteStop?.(stopId); return }
      const delta = e.key === 'ArrowRight' ? 1 : -1
      if (e.shiftKey) {
        let newDepart = depart ? shiftDateStr(depart, delta) : depart
        if (arrive && newDepart && newDepart < arrive) newDepart = arrive
        applyMove(stopId, arrive, newDepart)
      } else {
        applyMove(stopId, arrive ? shiftDateStr(arrive, delta) : arrive, depart ? shiftDateStr(depart, delta) : depart)
      }
    }
  }

  function bandGrabProps(stopId) {
    return {
      onPointerDown: makePointerDown('move', stopId),
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onKeyDown: bandKeyDown(stopId),
      onFocus: () => setFocusedStopId(stopId),
      onBlur: () => setFocusedStopId(id => (id === stopId ? null : id)),
      tabIndex: 0,
      'data-focused': focusedStopId === stopId || undefined,
      style: { touchAction: 'none', cursor: 'grab' },
    }
  }

  function bandHandleProps(stopId, edge) {
    // The handle is a DOM child of the band's own grab-body element (which
    // carries bandGrabProps' pointerdown/move/up), so every pointer event
    // fired here would otherwise also bubble up and re-trigger the band's
    // own "move" gesture on top of this "resize" one (last setGesture call
    // wins, silently turning every resize into a move) — stopPropagation on
    // all four keeps the two gestures from ever double-firing on one pointer.
    const down = makePointerDown(edge === 'start' ? 'resize-start' : 'resize-end', stopId)
    return {
      onPointerDown: e => { e.stopPropagation(); down(e) },
      onPointerMove: e => { e.stopPropagation(); handlePointerMove(e) },
      onPointerUp: e => { e.stopPropagation(); handlePointerUp(e) },
      onPointerCancel: e => { e.stopPropagation(); handlePointerCancel(e) },
      'aria-label': edge === 'start' ? 'Resize start of stop' : 'Resize end of stop',
      style: { touchAction: 'none', cursor: 'ew-resize' },
    }
  }

  function emptyCellProps(dayKey) {
    return {
      onPointerDown: makePointerDown('create', null),
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      'data-day': dayKey,
    }
  }

  const ghost = gesture && {
    type: gesture.type,
    stopId: gesture.stopId,
    startDay: gesture.startDay,
    currentDay: gesture.currentDay,
    deltaDays: daysBetweenDayKeys(gesture.startDay, gesture.currentDay),
  }

  return children({ gridRef, bandGrabProps, bandHandleProps, emptyCellProps, ghost, focusedStopId })
}
