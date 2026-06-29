import { useState, useEffect } from 'react'
import { getTripTimeline, backfillAccommodations, getDateWarnings, getPending } from '../api.js'
import StopCard, { computeCrossStopLayover, itemDateKey } from './StopCard.jsx'
import DocumentImportModal from './DocumentImportModal.jsx'
import PendingReview from './PendingReview.jsx'
import { RoleContext, canEdit } from '../roles.js'
import { useShowInbound, useHideStopFrames } from '../settings.js'
import { fmtDay } from '../dates.js'

export default function TripTimeline({ tripId, onStats, onStops }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [importing, setImporting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [warnings, setWarnings] = useState([])
  const [dismissed, setDismissed] = useState(false)
  const showInbound = useShowInbound()
  const hideStopFrames = useHideStopFrames()

  useEffect(() => { load() }, [tripId])

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

  async function load() {
    setLoading(true)
    try {
      const tl = await getTripTimeline(tripId)
      setTimeline(tl)
      // Legacy accommodation backfill — editors only (timeline also lazy-migrates).
      if (canEdit(tl.role)) { try { await backfillAccommodations(tripId) } catch (_) {} }
      try { const w = await getDateWarnings(tripId); setWarnings(w.warnings ?? []) } catch (_) {}
      try { const p = await getPending(tripId); setPendingCount(p.length) } catch (_) {}
    }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading timeline…</p>
  if (error)   return <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>
  if (!timeline?.stops?.length) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">No stops yet.</p>

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
    <RoleContext.Provider value={timeline.role ?? 'owner'}>
      <div>
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
          {timeline.stops.map((stop, i) => (
            <StopCard key={stop.id} stop={stop} index={i} onUpdate={load}
              inbound={inboundByStop[stop.id]} hideFrame={hideStopFrames}
              inboundConnection={inboundConnections[stop.id] ?? null}
              skipDays={skipDaysByStop[stop.id] ?? null} />
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
  )
}
