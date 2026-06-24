import { useState, useEffect } from 'react'
import { getTripTimeline, updateTrip, createStop } from '../api.js'
import EditStopCard from './EditStopCard.jsx'

function toDateInput(iso) { return iso ? iso.split('T')[0] : '' }
function fromDateInput(val) { return val ? val + 'T00:00:00' : null }

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
  const [saving, setSaving] = useState(false)
  const [addingStop, setAddingStop] = useState(false)

  useEffect(() => { load() }, [trip.id])

  async function load() {
    try { setTimeline(await getTripTimeline(trip.id)) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  function set(key, val) { setFields(f => ({ ...f, [key]: val })); setSaved(false) }

  async function save() {
    if (saved) return
    setError(null)
    if (fields.start_date && fields.end_date && fields.end_date < fields.start_date) {
      setError('End date cannot be before start date'); return
    }
    setSaving(true)
    try {
      await updateTrip(trip.id, {
        name: fields.name,
        start_date: fromDateInput(fields.start_date),
        end_date: fromDateInput(fields.end_date),
      })
      setSaved(true)
      onTripRenamed?.(fields.name)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
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

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading…</p>
  if (error)   return <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>

  const inputStyle = { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }

  return (
    <div className="space-y-5">
      <div style={{ background: 'var(--surface)', borderRadius: '0.75rem' }} className="px-5 py-4 space-y-4">
        <div>
          <label style={{ color: 'var(--text-faint)' }} className="block text-xs uppercase tracking-wide mb-1.5">
            Trip name
          </label>
          <input
            value={fields.name}
            onChange={e => set('name', e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            style={inputStyle}
            className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          {['start_date', 'end_date'].map(key => (
            <div key={key}>
              <label htmlFor={key} style={{ color: 'var(--text-faint)' }} className="block text-xs uppercase tracking-wide mb-1.5">
                {key === 'start_date' ? 'Start date' : 'End date'}
              </label>
              <input
                id={key}
                type="date"
                value={fields[key]}
                min={key === 'end_date' ? (fields.start_date || undefined) : undefined}
                onChange={e => set(key, e.target.value)}
                style={inputStyle}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3">
          <span style={{ color: saved ? 'var(--text-faint)' : 'var(--accent)' }} className="text-xs">
            {saved ? 'Saved ✓' : 'Unsaved changes'}
          </span>
          <button
            onClick={save}
            disabled={saved || saving}
            style={{
              background: saved ? 'var(--border)' : 'var(--accent)',
              color: saved ? 'var(--text-faint)' : 'var(--accent-fg)',
            }}
            className="px-4 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save trip'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {timeline?.stops?.map((stop, i) => (
          <EditStopCard key={stop.id} stop={stop} index={i} onRefresh={load} />
        ))}
      </div>

      <button
        onClick={addStop}
        disabled={addingStop}
        style={{ border: '1px dashed var(--text-faint)', color: 'var(--text-muted)' }}
        className="w-full rounded-xl py-3 text-sm transition-colors disabled:opacity-50"
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--text-faint)'; e.currentTarget.style.color = 'var(--text-muted)' }}
      >
        {addingStop ? 'Adding…' : '+ Add stop'}
      </button>
    </div>
  )
}
