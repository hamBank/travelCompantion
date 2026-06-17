import { useState } from 'react'
import { updateItem } from '../api.js'

const INPUT = {
  background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #313244',
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label style={{ color: '#6c7086' }} className="text-xs uppercase tracking-wide">{label}</label>
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={INPUT}
        className="rounded-lg px-3 py-2 text-sm outline-none focus:border-[#cba6f7]"
      />
    </div>
  )
}

function TextArea({ label, value, onChange, placeholder }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label style={{ color: '#6c7086' }} className="text-xs uppercase tracking-wide">{label}</label>
      <textarea
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        style={{ ...INPUT, resize: 'vertical' }}
        className="rounded-lg px-3 py-2 text-sm outline-none focus:border-[#cba6f7]"
      />
    </div>
  )
}

function AccommodationForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  return (
    <div className="space-y-4">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Hotel Roma" />
      <Field label="Location / Address" value={d('location')} onChange={v => setD('location', v)} placeholder="Via Nazionale 7, Rome" />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Check-in" type="datetime-local" value={d('checkin')} onChange={v => setD('checkin', v)} />
        <Field label="Check-out" type="datetime-local" value={d('checkout')} onChange={v => setD('checkout', v)} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Total cost" value={core.cost} onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="€450" />
        <Field label="Amount paid" value={d('amount_paid')} onChange={v => setD('amount_paid', v)} placeholder="€225" />
      </div>

      <Field label="Booking confirmation" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="ABC123XYZ" />

      <div>
        <p style={{ color: '#6c7086' }} className="text-xs uppercase tracking-wide mb-2">Contact</p>
        <div style={{ background: '#181825', border: '1px solid #313244' }} className="rounded-lg p-3 space-y-3">
          <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+39 06 123456" />
          <Field label="Website" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
          <Field label="Email" value={d('contact_email')} onChange={v => setD('contact_email', v)} placeholder="info@hotel.com" />
        </div>
      </div>

      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="Breakfast included, rooftop terrace…" />
    </div>
  )
}

function GenericForm({ core, setCore }) {
  return (
    <div className="space-y-3">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Activity name" />
      <Field label="Notes / time" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="09:00" />
      <Field label="Link" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <Field label="Cost" value={core.cost} onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="€20" />
    </div>
  )
}

const KIND_LABEL = {
  activity: 'Activity',
  restaurant: 'Restaurant',
  note: 'Note',
  accommodation: 'Accommodation',
}

const KIND_COLOR = {
  activity: '#89b4fa',
  restaurant: '#a6e3a1',
  note: '#f9e2af',
  accommodation: '#cba6f7',
}

export default function ItemEditModal({ item, onSave, onClose }) {
  const [core, setCore] = useState({
    kind: item.kind ?? 'activity',
    name: item.name ?? '',
    cost: item.cost ?? '',
    link: item.link ?? '',
    notes: item.notes ?? '',
  })
  const [details, setDetails] = useState(item.details ?? {})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const updated = await updateItem(item.id, { ...core, details })
      onSave(updated)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const color = KIND_COLOR[core.kind] ?? '#9399b2'

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: '#1e1e2e', border: '1px solid #313244', maxHeight: '90vh' }}
        className="w-full max-w-lg rounded-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div style={{ borderBottom: '1px solid #313244' }} className="flex items-center gap-3 px-5 py-4">
          <select
            value={core.kind}
            onChange={e => setCore(c => ({ ...c, kind: e.target.value }))}
            style={{ color, background: `${color}18`, border: `1px solid ${color}40` }}
            className="text-xs px-2 py-1 rounded-full font-medium outline-none cursor-pointer"
          >
            {Object.keys(KIND_LABEL).map(k => (
              <option key={k} value={k} style={{ background: '#1e1e2e', color: '#cdd6f4' }}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <span className="flex-1 text-sm font-medium truncate">{core.name || item.name}</span>
          <button
            onClick={onClose}
            style={{ color: '#6c7086' }}
            className="hover:text-[#cdd6f4] transition-colors text-lg leading-none shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-5">
          {core.kind === 'accommodation' ? (
            <AccommodationForm
              core={core} details={details}
              setCore={setCore} setDetails={setDetails}
            />
          ) : (
            <GenericForm core={core} setCore={setCore} />
          )}
          {error && <p style={{ color: '#f38ba8' }} className="text-xs mt-3">{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #313244' }} className="flex items-center justify-end gap-3 px-5 py-4">
          <button
            onClick={onClose}
            style={{ color: '#6c7086' }}
            className="text-sm hover:text-[#cdd6f4] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            style={{ background: '#cba6f7', color: '#1e1e2e' }}
            className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
