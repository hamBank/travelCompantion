import { useState, useEffect } from 'react'
import { getTripTimeline, updateTrip, createStop } from '../api.js'
import EditStopCard from './EditStopCard.jsx'

function toDateInput(iso) {
  if (!iso) return ''
  return iso.split('T')[0]
}

function fromDateInput(val) {
  return val ? val + 'T00:00:00' : null
}

export default function EditTrip({ trip, onTripRenamed }) {
  const [timeline, setTimeline] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [fields, setFields] = useState({
    name: trip.name,
    start_date: toDateInput(trip.start_date),
    end_date: toDateInput(trip.end_date),
  })
  const [saved, setSaved] = useState(true)
  const [addingStop, setAddingStop] = useState(false)

  useEffect(() => { load() }, [trip.id])

  async function load() {
    try { setTimeline(await getTripTimeline(trip.id)) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  function set(key, val) {
    setFields(f => ({ ...f, [key]: val }))
    setSaved(false)
  }

  async function save() {
    if (saved) return
    try {
      await updateTrip(trip.id, {
        name: fields.name,
        start_date: fromDateInput(fields.start_date),
        end_date: fromDateInput(fields.end_date),
      })
      setSaved(true)
      onTripRenamed?.(fields.name)
    } catch (e) { setError(e.message) }
  }

  async function addStop() {
    setAddingStop(true)
    try {
      await createStop(trip.id, {
        location: 'New stop',
        sort_order: timeline?.stops?.length ?? 0,
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
      {/* Trip meta */}
      <div style={{ background: '#2a2a3e' }} className="rounded-xl px-5 py-4 space-y-4">
        <div>
          <label style={{ color: '#6c7086' }} className="block text-xs uppercase tracking-wide mb-1.5">
            Trip name
          </label>
          <input
            value={fields.name}
            onChange={e => set('name', e.target.value)}
            onBlur={save}
            onKeyDown={e => e.key === 'Enter' && save()}
            style={{ background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #313244' }}
            className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[#cba6f7]"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="trip-start-date" style={{ color: '#6c7086' }} className="block text-xs uppercase tracking-wide mb-1.5">
              Start date
            </label>
            <input
              id="trip-start-date"
              type="date"
              value={fields.start_date}
              onChange={e => set('start_date', e.target.value)}
              onBlur={save}
              style={{ background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #313244' }}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[#cba6f7]"
            />
          </div>
          <div>
            <label htmlFor="trip-end-date" style={{ color: '#6c7086' }} className="block text-xs uppercase tracking-wide mb-1.5">
              End date
            </label>
            <input
              id="trip-end-date"
              type="date"
              value={fields.end_date}
              onChange={e => set('end_date', e.target.value)}
              onBlur={save}
              style={{ background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #313244' }}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[#cba6f7]"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <span style={{ color: saved ? '#6c7086' : '#cba6f7' }} className="text-xs">
            {saved ? 'Saved ✓' : 'Unsaved changes'}
          </span>
        </div>
      </div>

      {/* Stops */}
      <div className="space-y-3">
        {timeline?.stops?.map((stop, i) => (
          <EditStopCard key={stop.id} stop={stop} index={i} onRefresh={load} />
        ))}
      </div>

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
