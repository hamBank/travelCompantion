import { useState, useEffect } from 'react'
import { getTripTimeline } from '../api.js'
import StopCard from './StopCard.jsx'

export default function TripTimeline({ tripId }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => { load() }, [tripId])

  async function load() {
    setLoading(true)
    try { setTimeline(await getTripTimeline(tripId)) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  if (loading) return <p style={{ color: '#6c7086' }} className="text-center py-12 text-sm">Loading timeline…</p>
  if (error) return <p style={{ color: '#f38ba8' }} className="text-center py-12 text-sm">{error}</p>
  if (!timeline?.stops?.length) return <p style={{ color: '#6c7086' }} className="text-center py-12 text-sm">No stops yet.</p>

  const completed = timeline.stops.filter(s => s.status === 'completed').length
  const total = timeline.stops.length

  return (
    <div className="space-y-3">
      {total > 0 && (
        <div className="flex items-center justify-between mb-4">
          <p style={{ color: '#9399b2' }} className="text-xs">
            {total} stops · {completed} completed
          </p>
          <div style={{ background: '#313244' }} className="rounded-full h-1.5 w-32 overflow-hidden">
            <div
              style={{ background: '#a6e3a1', width: `${(completed / total) * 100}%` }}
              className="h-full rounded-full transition-all"
            />
          </div>
        </div>
      )}
      {timeline.stops.map((stop, i) => (
        <StopCard key={stop.id} stop={stop} index={i} onUpdate={load} />
      ))}
    </div>
  )
}
