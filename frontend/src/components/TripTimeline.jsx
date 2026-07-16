import { useState, useEffect, useRef, useCallback } from 'react'
import { getTripTimeline, backfillAccommodations, getDateWarnings, getPending, updateItemStatus, updateStop } from '../api.js'
import StopCard, { computeCrossStopLayover, itemDateKey, itemEndMs, itemOccursOn, DayMap, dayMapPoints } from './StopCard.jsx'
import FlightDetailModal from './FlightDetailModal.jsx'
import RailDetailModal from './RailDetailModal.jsx'
import ItemDetailModal from './ItemDetailModal.jsx'
import DocumentImportModal from './DocumentImportModal.jsx'
import PendingReview from './PendingReview.jsx'
import { RoleContext, RealRoleContext, canEdit, effectiveRole } from '../roles.js'
import { useShowInbound, useHideStopFrames } from '../settings.js'
import { fmtDay } from '../dates.js'
import { getCurrentModal } from '../modalNav.js'
import { isEditing, onEditChange } from '../editState.js'
import { useOnline } from '../online.js'
import { offlineQueue, sendOp } from '../offlineQueue.js'
import { useSwipeNav } from '../swipeNav.js'
import { approxLocalDateStr } from '../tzutil.js'

// The stop whose [arrive, depart] range covers `dateStr`, if any — used to
// refine "today" using where the trip actually is on that day, rather than
// only the viewing device's own clock.
function stopCoveringDate(stops, dateStr) {
  return (stops || []).find(s => {
    const a = s.arrive ? String(s.arrive).slice(0, 10) : null
    const d = s.depart ? String(s.depart).slice(0, 10) : null
    if (!a && !d) return false
    if (a && dateStr < a) return false
    if (d && dateStr > d) return false
    return true
  }) || null
}

// Today-view defaults: today's date if it falls within the trip's dates,
// otherwise the trip's first day (or plain today when the trip has no
// dates set at all, so Today view still does something sensible).
//
// The device's own local date is the first guess (covers the common case —
// phones auto-adjust timezone while traveling). It's then refined against
// wherever the trip actually is on that day: a desktop that's never had its
// timezone updated, or a phone with a stale/manual TZ, would otherwise show
// the wrong day for a trip already in a very different timezone. Which stop
// counts as "current" can itself shift once the day is recomputed from that
// stop's location, so this takes a couple of rounds to settle rather than a
// single pass.
export function pickInitialDay(timeline) {
  const start = timeline?.start_date ? String(timeline.start_date).slice(0, 10) : null
  const end = timeline?.end_date ? String(timeline.end_date).slice(0, 10) : null
  const clamp = (d) => (start && d < start) ? start : (end && d > end) ? (start ?? d) : d

  let candidate = clamp(new Date().toLocaleDateString('sv-SE'))
  for (let i = 0; i < 2; i++) {
    const stop = stopCoveringDate(timeline?.stops, candidate)
    if (!stop || stop.lng == null) break
    const refined = clamp(approxLocalDateStr(stop.lng))
    if (refined === candidate) break
    candidate = refined
  }
  return candidate
}

export function shiftDay(dateStr, deltaDays) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + deltaDays)
  return d.toLocaleDateString('sv-SE')
}

// Clamp a day-navigation step to the trip's date span, when known. Returns
// the current day unchanged if the step would go out of bounds.
export function clampedShiftDay(dateStr, direction, timeline) {
  const next = shiftDay(dateStr, direction === 'next' ? 1 : -1)
  const start = timeline?.start_date ? String(timeline.start_date).slice(0, 10) : null
  const end = timeline?.end_date ? String(timeline.end_date).slice(0, 10) : null
  if (start && next < start) return dateStr
  if (end && next > end) return dateStr
  return next
}

// A "past pending" item must have ended this many hours ago before the
// catch-up banner nags about it — absorbs timezone slop and avoids flagging
// something that only just finished.
const GRACE_HOURS = 6

export default function TripTimeline({ tripId, onStats, onStops, todayMode = false, onExitToday, importing = false, setImporting = () => {} }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reviewing, setReviewing] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [warnings, setWarnings] = useState([])
  const [dismissed, setDismissed] = useState(false)
  const [pastPendingDismissed, setPastPendingDismissed] = useState(false)
  const [markingDone, setMarkingDone] = useState(false)
  const [markDoneError, setMarkDoneError] = useState(null)
  const [fixingStopTz, setFixingStopTz] = useState(null)  // stop_id mid-autofix, for its button's busy state
  const [navItem, setNavItem] = useState(null)
  const [renderKey, setRenderKey] = useState(0)  // force remount on data refresh
  const allItemsRef    = useRef([])
  const dataVersionRef = useRef(0)      // last known data_version from /health
  const pendingRefresh = useRef(false)  // queued while edit modal is open
  const showInbound = useShowInbound()
  const hideStopFrames = useHideStopFrames()
  const online = useOnline()
  const [selectedDay, setSelectedDay] = useState(null)  // 'YYYY-MM-DD', only meaningful while todayMode
  const dayInitializedRef = useRef(false)  // have we already picked a day for this todayMode "on" stint?

  useEffect(() => { load() }, [tripId])

  // Data-sync poller — silently refreshes trip data when the DB changes on another device
  useEffect(() => {
    if (!tripId) return

    function doRefresh() { pendingRefresh.current = false; load({ background: true }) }

    // When edit modal closes, flush any queued refresh
    const unsub = onEditChange(editing => {
      if (!editing && pendingRefresh.current) doRefresh()
    })

    const interval = setInterval(async () => {
      try {
        const r = await fetch('/health', { cache: 'no-store' })
        const { data_version } = await r.json()
        if (!data_version) return
        if (dataVersionRef.current === 0) { dataVersionRef.current = data_version; return }
        if (data_version === dataVersionRef.current) return
        dataVersionRef.current = data_version
        if (isEditing()) { pendingRefresh.current = true }
        else doRefresh()
      } catch { /* offline — ignore */ }
    }, 30_000)

    return () => { clearInterval(interval); unsub() }
  }, [tripId])

  // Global j/k handler — must be at top level, before any conditional returns
  useEffect(() => {
    function handleModalNav(e) {
      const { itemId, direction } = e.detail
      const items = allItemsRef.current
      const idx = items.findIndex(i => i.id === itemId)
      if (idx === -1) return
      const target = direction === 'next' ? items[idx + 1] : items[idx - 1]
      if (!target) return   // at boundary — modal stays open
      getCurrentModal()?.closeFn()
      setNavItem(target)
    }
    window.addEventListener('modalNav', handleModalNav)
    return () => window.removeEventListener('modalNav', handleModalNav)
  }, [])

  // Today-view day navigation — j/k, ArrowLeft/ArrowRight, and swipe left/
  // right, mirroring the detail-modal item navigation above. Clamped to the
  // trip's date span.
  const navigateDay = useCallback(direction => {
    setSelectedDay(day => (day == null ? day : clampedShiftDay(day, direction, timeline)))
  }, [timeline])

  useEffect(() => {
    if (!todayMode) return
    function onKey(e) {
      if (!['j', 'k', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      // A detail/edit modal owns j/k while it's open — don't fight it.
      if (isEditing() || getCurrentModal()) return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // Deliberately the reverse of the item-detail-modal mapping (j=next,
      // k=prev there) — k/ArrowRight move to the next day, j/ArrowLeft to
      // the previous, matching ArrowRight/ArrowLeft's natural forward/back
      // reading direction.
      const goingNext = e.key === 'k' || e.key === 'ArrowRight'
      navigateDay(goingNext ? 'next' : 'prev')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [todayMode, navigateDay])

  useSwipeNav(navigateDay, todayMode)

  // Pick the default day once per todayMode "on" stint (not on every background
  // refresh — timeline gets a new object reference on each poll/save, which
  // would otherwise reset navigation back to the default day mid-browse).
  useEffect(() => {
    if (!todayMode) { dayInitializedRef.current = false; setSelectedDay(null); return }
    if (dayInitializedRef.current || !timeline) return
    dayInitializedRef.current = true
    setSelectedDay(pickInitialDay(timeline))
  }, [todayMode, timeline])

  // Surface stop counts to the header (shown in the minimal title bar).
  useEffect(() => {
    if (timeline?.stops) {
      onStats?.({
        total: timeline.stops.length,
        completed: timeline.stops.filter(s => s.status === 'completed').length,
      })
      onStops?.(timeline.stops)
    }
  }, [timeline, onStats, onStops])

  // `background` skips the loading spinner (keeps the current view on screen
  // while fresh data comes in). `remount` force-recreates every StopCard via a
  // key bump — needed when data changed on another device (stale local edit
  // state could otherwise linger), but NOT wanted for a save that originated
  // in this same tab: that would reset each StopCard's open/closed state and
  // jump the scroll position, which is exactly the jarring reload this is
  // meant to avoid.
  async function load({ background = false, remount = background } = {}) {
    if (!background) setLoading(true)
    try {
      // Flush any queued offline writes before refetching — otherwise a
      // remount (the poller's default) rebuilds every StopCard straight from
      // the server's still-pre-edit snapshot, discarding local optimistic
      // state that only the queue (not the server) knows about yet. A no-op
      // when the queue is empty, which is the common case.
      await offlineQueue.flush(sendOp)
      // Plain URL for background refreshes too (no cache-buster): req() already
      // sends cache:'no-store' so the browser HTTP cache is bypassed, and the
      // service worker's NetworkFirst handler only refreshes its offline copy
      // for the plain URL — a ?sync=-busted one would leave the offline cache
      // frozen at whatever the initial page load fetched.
      const tl = await getTripTimeline(tripId)
      setTimeline(tl)
      if (remount) setRenderKey(k => k + 1)
      // Legacy accommodation backfill — editors only (timeline also lazy-migrates).
      if (canEdit(tl.role)) { try { await backfillAccommodations(tripId) } catch (_) {} }
      try { const w = await getDateWarnings(tripId); setWarnings(w.warnings ?? []) } catch (_) {}
      try { const p = await getPending(tripId); setPendingCount(p.length) } catch (_) {}
    }
    catch (e) { if (!background) setError(e.message) }
    finally { if (!background) setLoading(false) }
  }

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading timeline…</p>
  if (error)   return <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>
  if (!timeline?.stops?.length) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">No stops yet.</p>

  const activeDay = todayMode ? selectedDay : null

  // Today mode: only stops with at least one occurring-on-activeDay item, each
  // trimmed to just those items. Cross-stop computations below (layovers,
  // j/k nav, day-banner skip tracking) deliberately keep using the
  // UNfiltered timeline.stops — only the rendered StopCard list is filtered.
  const visibleStops = activeDay
    ? timeline.stops
        .map(s => ({ ...s, items: s.items.filter(i => itemOccursOn(i, activeDay)) }))
        .filter(s => s.items.length > 0)
    : timeline.stops

  const dayNavHeader = todayMode && activeDay && (
    <div className="flex items-center justify-center gap-3 mb-3">
      <button
        onClick={() => navigateDay('prev')}
        style={{ color: 'var(--text-muted)' }}
        className="text-sm px-1.5 hover:opacity-70 transition-opacity"
        aria-label="Previous day"
      >
        ◀
      </button>
      <span style={{ color: 'var(--text)' }} className="text-sm font-medium min-w-[9rem] text-center">
        {fmtDay(activeDay)}
      </span>
      <button
        onClick={() => navigateDay('next')}
        style={{ color: 'var(--text-muted)' }}
        className="text-sm px-1.5 hover:opacity-70 transition-opacity"
        aria-label="Next day"
      >
        ▶
      </button>
    </div>
  )

  if (activeDay && visibleStops.length === 0) {
    return (
      <div className="text-center py-12">
        {dayNavHeader}
        <p style={{ color: 'var(--text-faint)' }} className="text-sm mb-2">Nothing scheduled today.</p>
        {onExitToday && (
          <button
            onClick={onExitToday}
            style={{ color: 'var(--accent)' }}
            className="text-xs font-medium hover:opacity-70 transition-opacity underline"
          >
            Show full timeline
          </button>
        )}
      </div>
    )
  }

  // Build global sorted item list for cross-stop j/k navigation
  const allItems = timeline.stops.flatMap(s =>
    s.items.filter(i => i.kind !== 'food' && i.kind !== 'purchase')
  ).sort((a, b) => {
    const t = i => {
      const d = i.details || {}
      if (i.kind === 'flight' || i.kind === 'rail') return d.depart_time || ''
      if (i.kind === 'accommodation') return d.checkin || i.scheduled_at || ''
      return i.scheduled_at || ''
    }
    return t(a).localeCompare(t(b))
  })
  allItemsRef.current = allItems

  // Items still "pending" well after they should be over — surfaced as a
  // one-tap catch-up banner rather than silently auto-marked done (multi-user
  // trips and mismatched device clocks make auto-writing unsafe).
  const pastPending = allItems.filter(i =>
    i.status === 'pending' &&
    itemEndMs(i) != null &&
    itemEndMs(i) < Date.now() - GRACE_HOURS * 3600_000)

  async function markPastPendingDone() {
    if (markingDone) return
    setMarkingDone(true); setMarkDoneError(null)
    try {
      await Promise.all(pastPending.map(i => updateItemStatus(i.id, 'done')))
      await load({ background: true, remount: false })
    } catch (e) { setMarkDoneError(e.message) }
    finally { setMarkingDone(false) }
  }

  // One-click fix for a "Timezone mismatch" warning — PATCHes the stop to the
  // warning's suggested_timezone (the location's real offset, computed
  // server-side in backend/validation.py), then reloads so the warning clears.
  async function fixStopTimezone(stopId, timezone) {
    if (fixingStopTz != null) return
    setFixingStopTz(stopId)
    try {
      await updateStop(stopId, { timezone })
      await load({ background: true, remount: false })
    } catch (_) {}
    finally { setFixingStopTz(null) }
  }

  // Inbound transport: for each stop, the flight/rail (filed on a *different* stop)
  // whose arrival date matches this stop's arrival date — i.e. how you got here.
  const datePart = v => (v ? String(v).split('T')[0] : null)
  // Arrival time per transport kind: flights/rail carry details.arrive_time;
  // road transfers have no arrive_time, so fall back to their scheduled time.
  const arrivalTimeOf = it => {
    if (it.kind === 'flight' || it.kind === 'rail') return it.details?.arrive_time
    if (it.kind === 'transfer') return it.details?.arrive_time || it.scheduled_at
    return null
  }
  const transport = []
  for (const s of timeline.stops)
    for (const it of s.items) {
      const at = arrivalTimeOf(it)
      if (at) transport.push({ item: it, stopId: s.id, arrive: at })
    }

  function inboundFor(stop) {
    const d = datePart(stop.arrive)
    if (!d) return null
    const matches = transport.filter(t => t.stopId !== stop.id && datePart(t.arrive) === d)
    if (!matches.length) return null
    matches.sort((a, b) => new Date(b.arrive) - new Date(a.arrive))
    return matches[0].item
  }

  // Resolve each stop's inbound banner. The transport item also keeps its normal
  // card on its own (departure) stop — banner is an additional arrival marker.
  const inboundByStop = {}
  if (showInbound) {
    const usedInbounds = new Set()
    for (const stop of timeline.stops) {
      const inb = inboundFor(stop)
      if (inb && !usedInbounds.has(inb.id)) {
        inboundByStop[stop.id] = inb
        usedInbounds.add(inb.id)
      }
    }
  }

  // Cross-stop connections shown on the DESTINATION stop (after InboundBanner)
  const inboundConnections = {}
  for (let i = 0; i < timeline.stops.length - 1; i++) {
    const conn = computeCrossStopLayover(timeline.stops[i], timeline.stops[i + 1])
    if (conn) inboundConnections[timeline.stops[i + 1].id] = conn
  }

  // In frameless mode, track which day-banner dates have already been rendered
  // by a previous stop so we don't repeat them.
  const skipDaysByStop = {}
  if (hideStopFrames) {
    const seen = new Set()
    for (const stop of timeline.stops) {
      skipDaysByStop[stop.id] = new Set(seen)
      for (const it of stop.items) {
        const dk = itemDateKey(it)
        if (dk) seen.add(dk)
      }
    }
  }

  // Offline, the whole timeline is read-only whatever the trip role — the
  // provider cascade hides every edit affordance in StopCard/detail modals.
  const role = effectiveRole(timeline.role, online)
  const editable = canEdit(role)

  return (
    <>
    <RoleContext.Provider value={role}>
    <RealRoleContext.Provider value={timeline.role}>
      <div>
        {!online && (
          <p style={{ color: 'var(--text-faint)' }} className="text-xs mb-3">Showing cached data</p>
        )}
        {dayNavHeader}
        {editable && pastPending.length > 0 && !pastPendingDismissed && (
          <div
            style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)' }}
            className="mb-4 rounded-lg px-3 py-2.5"
          >
            <div className="flex items-start gap-2">
              <span style={{ color: 'var(--warning)' }} className="text-sm">⚠</span>
              <div className="flex-1 min-w-0">
                <p style={{ color: 'var(--text)' }} className="text-xs font-medium mb-1">
                  {pastPending.length} past item{pastPending.length > 1 ? 's' : ''} still pending
                </p>
                {markDoneError && (
                  <p style={{ color: 'var(--error)' }} className="text-xs mb-1">{markDoneError}</p>
                )}
                <button
                  onClick={markPastPendingDone}
                  disabled={markingDone}
                  style={{ color: 'var(--accent)' }}
                  className="text-xs font-medium hover:opacity-70 transition-opacity underline disabled:opacity-50"
                >
                  {markingDone ? 'Marking done…' : 'Mark all done'}
                </button>
              </div>
              <button onClick={() => setPastPendingDismissed(true)} style={{ color: 'var(--text-faint)' }} className="text-sm leading-none hover:opacity-70">✕</button>
            </div>
          </div>
        )}
        {editable && warnings.length > 0 && !dismissed && (
          <div
            style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)' }}
            className="mb-4 rounded-lg px-3 py-2.5"
          >
            <div className="flex items-start gap-2">
              <span style={{ color: 'var(--warning)' }} className="text-sm">⚠</span>
              <div className="flex-1 min-w-0">
                <p style={{ color: 'var(--text)' }} className="text-xs font-medium mb-1">
                  {warnings.length} date/coverage warning{warnings.length > 1 ? 's' : ''}
                </p>
                <ul style={{ color: 'var(--text-faint)' }} className="text-xs space-y-0.5">
                  {warnings.map((w, i) => (
                    // item_id is null for gap-style warnings (uncovered nights, missing
                    // transport) — they aren't about one specific item, so fall back to a
                    // position-based key (the list is re-fetched wholesale on each load,
                    // never reordered in place, so this is stable enough for React's diff).
                    <li key={w.item_id ?? `gap-${i}`}>
                      <span style={{ color: 'var(--text-muted)' }}>{w.stop_location}:</span>{' '}
                      {w.name} — {fmtDay(w.item_date)} ({w.reason})
                      {w.suggested_timezone != null && w.stop_id != null && (
                        <button
                          onClick={() => fixStopTimezone(w.stop_id, w.suggested_timezone)}
                          disabled={fixingStopTz === w.stop_id}
                          style={{ color: 'var(--accent)' }}
                          className="ml-1.5 font-medium hover:opacity-70 transition-opacity underline disabled:opacity-50"
                        >
                          {fixingStopTz === w.stop_id ? 'Fixing…' : `Fix → UTC${Number(w.suggested_timezone) >= 0 ? '+' : ''}${w.suggested_timezone}`}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <button onClick={() => setDismissed(true)} style={{ color: 'var(--text-faint)' }} className="text-sm leading-none hover:opacity-70">✕</button>
            </div>
          </div>
        )}

        {importing && (
          <DocumentImportModal
            tripId={tripId}
            onClose={() => setImporting(false)}
            onParsed={() => { setImporting(false); setReviewing(true); load() }}
          />
        )}

        {reviewing && (
          <PendingReview
            tripId={tripId}
            stops={timeline.stops}
            onClose={() => { setReviewing(false); load() }}
            onChanged={load}
          />
        )}

        <div className="space-y-1.5">
          {visibleStops.map((stop, i) => (
            <StopCard key={`${stop.id}-${renderKey}`} stop={stop} index={i}
              onUpdate={() => load({ background: true, remount: false })}
              inbound={inboundByStop[stop.id]} hideFrame={hideStopFrames}
              inboundConnection={inboundConnections[stop.id] ?? null}
              skipDays={skipDaysByStop[stop.id] ?? null}
              forceOpen={!!activeDay} tripId={tripId} />
          ))}
        </div>

        {/* Single-day view only, and always just one map — even when today's
            items span a spillover day-group (e.g. a multi-night booking whose
            own date key is yesterday), every visible stop's items for
            activeDay are combined into one map, shown below all of today's
            item cards. */}
        {activeDay && visibleStops.length > 0 && (
          <DayMap stopId={visibleStops[0].id} points={dayMapPoints(visibleStops.flatMap(s => s.items), activeDay)} />
        )}

        {editable && pendingCount > 0 && (
          <div className="mt-4 flex gap-2 flex-wrap">
            <button
              onClick={() => setReviewing(true)}
              style={{ color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}
              className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 transition-opacity"
            >
              Review pending ({pendingCount})
            </button>
          </div>
        )}
      </div>
    </RealRoleContext.Provider>
    </RoleContext.Provider>

    {navItem && (() => {
      const close = () => setNavItem(null)
      const save  = updated => setNavItem(updated)
      if (navItem.kind === 'flight')
        return <FlightDetailModal key={navItem.id} item={navItem} onClose={close} onSave={save} isNavModal />
      if (navItem.kind === 'rail')
        return <RailDetailModal key={navItem.id} item={navItem} onClose={close} onSave={save} isNavModal />
      return <ItemDetailModal key={navItem.id} item={navItem} onClose={close} onEdit={() => {}} isNavModal />
    })()}
    </>
  )
}
