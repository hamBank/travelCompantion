import { useState, useEffect, useRef, useCallback } from 'react'
import { getTripTimeline, backfillAccommodations, getDateWarnings, getPending } from '../api.js'
import StopCard, { computeCrossStopLayover, itemDateKey, itemOccursOn } from './StopCard.jsx'
import FlightDetailModal from './FlightDetailModal.jsx'
import RailDetailModal from './RailDetailModal.jsx'
import ItemDetailModal from './ItemDetailModal.jsx'
import DocumentImportModal from './DocumentImportModal.jsx'
import PendingReview from './PendingReview.jsx'
import { RoleContext, canEdit } from '../roles.js'
import { useShowInbound, useHideStopFrames } from '../settings.js'
import { fmtDay } from '../dates.js'
import { getCurrentModal } from '../modalNav.js'
import { isEditing, onEditChange } from '../editState.js'
import { useOnline } from '../online.js'
import { useSwipeNav } from '../swipeNav.js'

// Today-view defaults: today's date if it falls within the trip's dates,
// otherwise the trip's first day (or plain today when the trip has no
// dates set at all, so Today view still does something sensible).
export function pickInitialDay(timeline) {
  const now = new Date().toLocaleDateString('sv-SE')
  const start = timeline?.start_date ? String(timeline.start_date).slice(0, 10) : null
  const end = timeline?.end_date ? String(timeline.end_date).slice(0, 10) : null
  if (start && now < start) return start
  if (end && now > end) return start ?? now
  return now
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

export default function TripTimeline({ tripId, onStats, onStops, todayMode = false, onExitToday }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [importing, setImporting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [warnings, setWarnings] = useState([])
  const [dismissed, setDismissed] = useState(false)
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

  // Today-view day navigation — j/k and swipe left/right, mirroring the
  // detail-modal item navigation above. Clamped to the trip's date span.
  const navigateDay = useCallback(direction => {
    setSelectedDay(day => (day == null ? day : clampedShiftDay(day, direction, timeline)))
  }, [timeline])

  useEffect(() => {
    if (!todayMode) return
    function onKey(e) {
      if (e.key !== 'j' && e.key !== 'k') return
      // A detail/edit modal owns j/k while it's open — don't fight it.
      if (isEditing() || getCurrentModal()) return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // Deliberately the reverse of the item-detail-modal mapping (j=next,
      // k=prev there) — k moves to the next day, j to the previous.
      navigateDay(e.key === 'k' ? 'next' : 'prev')
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
      const tl = background
        ? await getTripTimeline(tripId, { sync: Date.now() })  // cache-bust query param for background refreshes
        : await getTripTimeline(tripId)
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

  const editable = canEdit(timeline.role)

  return (
    <>
    <RoleContext.Provider value={timeline.role ?? 'owner'}>
      <div>
        {!online && (
          <p style={{ color: 'var(--text-faint)' }} className="text-xs mb-3">Showing cached data</p>
        )}
        {dayNavHeader}
        {editable && warnings.length > 0 && !dismissed && (
          <div
            style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)' }}
            className="mb-4 rounded-lg px-3 py-2.5"
          >
            <div className="flex items-start gap-2">
              <span style={{ color: 'var(--warning)' }} className="text-sm">⚠</span>
              <div className="flex-1 min-w-0">
                <p style={{ color: 'var(--text)' }} className="text-xs font-medium mb-1">
                  {warnings.length} item{warnings.length > 1 ? 's' : ''} dated outside their stop
                </p>
                <ul style={{ color: 'var(--text-faint)' }} className="text-xs space-y-0.5">
                  {warnings.map(w => (
                    <li key={w.item_id}>
                      <span style={{ color: 'var(--text-muted)' }}>{w.stop_location}:</span>{' '}
                      {w.name} — {fmtDay(w.item_date)} ({w.reason})
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
              forceOpen={!!activeDay} />
          ))}
        </div>

        {editable && (
          <div className="mt-4 flex gap-2 flex-wrap">
            <button
              onClick={() => setImporting(true)}
              style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}
              className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 transition-opacity"
            >
              ⇪ Import from document
            </button>
            {pendingCount > 0 && (
              <button
                onClick={() => setReviewing(true)}
                style={{ color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}
                className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 transition-opacity"
              >
                Review pending ({pendingCount})
              </button>
            )}
          </div>
        )}
      </div>
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
