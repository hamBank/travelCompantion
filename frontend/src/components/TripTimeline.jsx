import { useState, useEffect } from 'react'
import { getTripTimeline, backfillAccommodations } from '../api.js'
import StopCard from './StopCard.jsx'
import { RoleContext, canEdit } from '../roles.js'
import { useShowInbound } from '../settings.js'

export default function TripTimeline({ tripId }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
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
  const transport = []
  for (const s of timeline.stops)
    for (const it of s.items)
      if ((it.kind === 'flight' || it.kind === 'rail') && it.details?.arrive_time)
        transport.push({ item: it, stopId: s.id })

  function inboundFor(stop) {
    const d = datePart(stop.arrive)
    if (!d) return null
    const matches = transport.filter(t => t.stopId !== stop.id && datePart(t.item.details.arrive_time) === d)
    if (!matches.length) return null
    matches.sort((a, b) => new Date(b.item.details.arrive_time) - new Date(a.item.details.arrive_time))
    return matches[0].item
  }

  // Resolve each stop's inbound banner up front, and collect the item ids used so a
  // flight/rail shown as a banner is NOT also rendered as a normal card elsewhere.
  // Only when the feature is enabled — otherwise items must keep their normal cards.
  const inboundByStop = {}
  const bannerItemIds = new Set()
  if (showInbound) {
    for (const stop of timeline.stops) {
      const inb = inboundFor(stop)
      if (inb) { inboundByStop[stop.id] = inb; bannerItemIds.add(inb.id) }
    }
  }

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

        <div className="space-y-1.5">
          {timeline.stops.map((stop, i) => (
            <StopCard key={stop.id} stop={stop} index={i} onUpdate={load}
              inbound={inboundByStop[stop.id]} hiddenItemIds={bannerItemIds} />
          ))}
        </div>
      </div>
    </RoleContext.Provider>
  )
}
