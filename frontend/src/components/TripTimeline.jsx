import { useState, useEffect } from 'react'
import { getTripTimeline, backfillAccommodations } from '../api.js'
import StopCard from './StopCard.jsx'

export default function TripTimeline({ tripId }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => { load() }, [tripId])

  async function load() {
    setLoading(true)
    try {
      try { await backfillAccommodations(tripId) } catch (_) {}
      setTimeline(await getTripTimeline(tripId))
    }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading timeline…</p>
  if (error)   return <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>
  if (!timeline?.stops?.length) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">No stops yet.</p>

  const completed = timeline.stops.filter(s => s.status === 'completed').length
  const total = timeline.stops.length

  return (
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

      <div className="space-y-3">
        {timeline.stops.map((stop, i) => (
          <StopCard key={stop.id} stop={stop} index={i} onUpdate={load} />
        ))}
      </div>
    </div>
  )
}
