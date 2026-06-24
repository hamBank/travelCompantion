import { useState } from 'react'
import { updateStop, deleteStop } from '../api.js'
import EditItemsSection from './EditItemsSection.jsx'

const STATUS_OPTIONS = ['planned', 'confirmed', 'completed', 'cancelled']

function Field({ label, value, onChange, placeholder, type = 'text', span = 1, min }) {
  return (
    <div className={span === 2 ? 'col-span-2' : ''}>
      <label style={{ color: 'var(--text-faint)' }} className="block text-xs mb-0.5">{label}</label>
      <input
        type={type}
        value={value ?? ''}
        min={min || undefined}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
        className="w-full rounded px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
      />
    </div>
  )
}

function toDateInput(iso) { return iso ? iso.split('T')[0] : '' }
function fromDateInput(val) { return val ? val + 'T00:00:00' : null }

export default function EditStopCard({ stop, index, onRefresh }) {
  const [open, setOpen] = useState(false)
  const [fields, setFields] = useState({
    location: stop.location,
    country: stop.country ?? '',
    arrive: toDateInput(stop.arrive),
    depart: toDateInput(stop.depart),
    timezone: stop.timezone ?? '0',
    lat: stop.lat ?? '',
    lng: stop.lng ?? '',
    status: stop.status,
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  function set(key, val) { setFields(f => ({ ...f, [key]: val })); setSaved(false) }

  async function save() {
    if (fields.arrive && fields.depart && fields.depart < fields.arrive) {
      setError('Departure date cannot be before arrival date'); return
    }
    setSaving(true); setError(null)
    try {
      await updateStop(stop.id, {
        ...fields,
        arrive: fromDateInput(fields.arrive),
        depart: fromDateInput(fields.depart),
      })
      setSaved(true)
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete stop "${stop.location}" and all its items?`)) return
    try { await deleteStop(stop.id); onRefresh() }
    catch (e) { setError(e.message) }
  }

  return (
    <div style={{ background: 'var(--surface)', borderRadius: '0.75rem', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
      >
        <span style={{ color: 'var(--text-faint)', fontSize: '0.7rem', minWidth: '1.2rem' }}>{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">
            {fields.location || <span style={{ color: 'var(--text-faint)' }}>Untitled stop</span>}
          </div>
          {(fields.arrive || fields.depart) && (
            <div style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5">
              {fields.arrive}{fields.depart ? ` → ${fields.depart}` : ''}
            </div>
          )}
        </div>
        <span style={{ color: 'var(--text-faint)', fontSize: '0.65rem' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)' }} className="px-5 py-4 space-y-5">
          <div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">Location</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City / location" value={fields.location} onChange={v => set('location', v)} placeholder="Paris" span={2} />
              <Field label="Country" value={fields.country} onChange={v => set('country', v)} placeholder="France" />
              <Field label="Timezone (UTC offset)" value={fields.timezone} onChange={v => set('timezone', v)} placeholder="+1" />
              <Field label="Latitude" value={fields.lat} onChange={v => set('lat', v)} placeholder="48.8566" />
              <Field label="Longitude" value={fields.lng} onChange={v => set('lng', v)} placeholder="2.3522" />
            </div>
          </div>

          <div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">Dates</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Arrive" value={fields.arrive} onChange={v => set('arrive', v)} type="date" />
              <Field label="Depart" value={fields.depart} onChange={v => set('depart', v)} type="date" min={fields.arrive} />
            </div>
          </div>

          <div className="flex items-center gap-4 pt-1">
            <div>
              <label style={{ color: 'var(--text-faint)' }} className="block text-xs mb-0.5">Status</label>
              <select
                value={fields.status}
                onChange={e => set('status', e.target.value)}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="rounded px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
              >
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="flex-1" />
            <button
              onClick={handleDelete}
              style={{ color: 'var(--text-faint)' }}
              className="text-xs hover:opacity-70 transition-opacity"
              onMouseEnter={e => e.currentTarget.style.color = 'var(--error)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
            >
              Delete stop
            </button>
            <button
              onClick={save}
              disabled={saving}
              style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
              className="px-4 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save stop'}
            </button>
          </div>

          {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}

          <div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">
              Activities &amp; Restaurants
            </p>
            <EditItemsSection stopId={stop.id} items={stop.items ?? []} onRefresh={onRefresh} />
          </div>
        </div>
      )}
    </div>
  )
}
