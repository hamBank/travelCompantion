import { useState, useEffect } from 'react'
import { getTripTimeline, updateTrip, createStop } from '../api.js'
import EditStopCard from './EditStopCard.jsx'

export default function EditTrip({ trip, onTripRenamed }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tripName, setTripName] = useState(trip.name)
  const [nameSaved, setNameSaved] = useState(true)
  const [addingStop, setAddingStop] = useState(false)

  useEffect(() => { load() }, [trip.id])

  async function load() {
    try { setTimeline(await getTripTimeline(trip.id)) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function saveName() {
    if (nameSaved || tripName === trip.name) { setNameSaved(true); return }
    try {
      await updateTrip(trip.id, { name: tripName })
      setNameSaved(true)
      onTripRenamed?.(tripName)
    } catch (e) { setError(e.message) }
  }

  async function addStop() {
    setAddingStop(true)
    try {
      const nextOrder = (timeline?.stops?.length ?? 0)
      await createStop(trip.id, {
        location: 'New stop',
        sort_order: nextOrder,
        status: 'planned',
      })
      await load()
    } catch (e) { setError(e.message) }
    finally { setAddingStop(false) }
  }

  if (loading) return <p style={{ color: '#6c7086' }} className="text-center py-12 text-sm">Loading…</p>
  if (error) return <p style={{ color: '#f38ba8' }} className="text-center py-12 text-sm">{error}</p>

  return (
    <div className="space-y-5">
      {/* Trip name */}
      <div style={{ background: '#2a2a3e' }} className="rounded-xl px-5 py-4">
        <label style={{ color: '#6c7086' }} className="block text-xs uppercase tracking-wide mb-2">Trip name</label>
        <div className="flex gap-3">
          <input
            value={tripName}
            onChange={e => { setTripName(e.target.value); setNameSaved(false) }}
            onBlur={saveName}
            onKeyDown={e => e.key === 'Enter' && saveName()}
            style={{ background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #313244' }}
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#cba6f7]"
          />
          <span style={{ color: nameSaved ? '#6c7086' : '#cba6f7' }} className="text-xs self-center">
            {nameSaved ? 'Saved ✓' : 'Unsaved'}
          </span>
        </div>
      </div>

      {/* Stops */}
      <div className="space-y-3">
        {timeline?.stops?.map((stop, i) => (
          <EditStopCard
            key={stop.id}
            stop={stop}
            index={i}
            onRefresh={load}
          />
        ))}
      </div>

      {/* Add stop */}
      <button
        onClick={addStop}
        disabled={addingStop}
        style={{ border: '1px dashed #6c7086', color: '#9399b2' }}
        className="w-full rounded-xl py-3 text-sm hover:border-[#cba6f7] hover:text-[#cba6f7] transition-colors disabled:opacity-50"
      >
        {addingStop ? 'Adding…' : '+ Add stop'}
      </button>
    </div>
  )
}
