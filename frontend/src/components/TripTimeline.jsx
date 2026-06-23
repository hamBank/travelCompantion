import { useState, useEffect } from 'react'
import { getTripTimeline, backfillAccommodations } from '../api.js'
import StopCard from './StopCard.jsx'
import DocumentImportModal from './DocumentImportModal.jsx'
import { RoleContext, canEdit } from '../roles.js'
import { useShowInbound } from '../settings.js'

export default function TripTimeline({ tripId }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [importing, setImporting] = useState(false)
  const showInbound = useShowInbound()

  useEffect(() => { load() }, [tripId])

  async function load() {
    setLoading(true)
    try {
      const tl = await getTripTimeline(tripId)
      setTimeline(tl)
      // Legacy accommodation backfill — editors only (timeline also lazy-migrates).
      if (canEdit(tl.role)) { try { await backfillAccommodations(tripId) } catch (_) {} }
    }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading timeline…</p>
  if (error)   return <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>
  if (!timeline?.stops?.length) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">No stops yet.</p>

  const completed = timeline.stops.filter(s => s.status === 'completed').length
  const total = timeline.stops.length

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
    for (const stop of timeline.stops) {
      const inb = inboundFor(stop)
      if (inb) inboundByStop[stop.id] = inb
    }
  }

  const editable = canEdit(timeline.role)

  return (
    <RoleContext.Provider value={timeline.role ?? 'owner'}>
      <div>
        {total > 0 && (
          <div className="flex items-center justify-between mb-5">
            <p style={{ color: 'var(--text-faint)' }} className="text-xs">
              {total} stops · {completed} completed
            </p>
            <div style={{ background: 'var(--border)' }} className="rounded-full h-1.5 w-32 overflow-hidden">
              <div
                style={{ background: 'var(--success)', width: `${(completed / total) * 100}%` }}
                className="h-full rounded-full transition-all"
              />
            </div>
          </div>
        )}

        {editable && (
          <div className="mb-4">
            <button
              onClick={() => setImporting(true)}
              style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}
              className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 transition-opacity"
            >
              ⇪ Import from document
            </button>
          </div>
        )}

        {importing && (
          <DocumentImportModal
            tripId={tripId}
            onClose={() => setImporting(false)}
            onCreated={() => { setImporting(false); load() }}
          />
        )}

        <div className="space-y-1.5">
          {timeline.stops.map((stop, i) => (
            <StopCard key={stop.id} stop={stop} index={i} onUpdate={load}
              inbound={inboundByStop[stop.id]} />
          ))}
        </div>
      </div>
    </RoleContext.Provider>
  )
}
