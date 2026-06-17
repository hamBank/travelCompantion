import { useState } from 'react'
import { updateItem } from '../api.js'

const KIND_VAR = {
  activity:      'var(--kind-activity)',
  restaurant:    'var(--kind-restaurant)',
  note:          'var(--kind-note)',
  accommodation: 'var(--kind-accommodation)',
  flight:        'var(--kind-flight)',
}

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">{label}</label>
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
        className="rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
      />
    </div>
  )
}

function TextArea({ label, value, onChange, placeholder, rows = 2 }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">{label}</label>
      <textarea
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', resize: 'vertical' }}
        className="rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
      />
    </div>
  )
}

function SectionBox({ label, children }) {
  return (
    <div>
      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">{label}</p>
      <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }} className="rounded-lg p-3 space-y-3">{children}</div>
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
      <SectionBox label="Contact">
        <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+39 06 123456" />
        <Field label="Website" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
        <Field label="Email" value={d('contact_email')} onChange={v => setD('contact_email', v)} placeholder="info@hotel.com" />
      </SectionBox>
      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="Breakfast included, rooftop terrace…" />
    </div>
  )
}

function FlightForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  return (
    <div className="space-y-4">
      <Field label="Label" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="SIN → HEL" />
      <SectionBox label="Route">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From (IATA)" value={d('origin')} onChange={v => setD('origin', v)} placeholder="SIN" />
          <Field label="To (IATA)" value={d('destination')} onChange={v => setD('destination', v)} placeholder="HEL" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Flight number" value={d('flight_number')} onChange={v => setD('flight_number', v)} placeholder="AY 132" />
          <Field label="Airline" value={d('airline')} onChange={v => setD('airline', v)} placeholder="Finnair" />
        </div>
      </SectionBox>
      <SectionBox label="Schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Departs" type="datetime-local" value={d('depart_time')} onChange={v => setD('depart_time', v)} />
          <Field label="Arrives" type="datetime-local" value={d('arrive_time')} onChange={v => setD('arrive_time', v)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Terminal" value={d('origin_terminal')} onChange={v => setD('origin_terminal', v)} placeholder="T1" />
          <Field label="Depart TZ" value={d('depart_tz')} onChange={v => setD('depart_tz', v)} placeholder="GMT+8" />
          <Field label="Arrive TZ" value={d('arrive_tz')} onChange={v => setD('arrive_tz', v)} placeholder="GMT+3" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="13h 25m" />
          <Field label="Seats" value={d('seats')} onChange={v => setD('seats', v)} placeholder="12A, 12B" />
        </div>
      </SectionBox>
      <SectionBox label="Connection">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Layover" value={d('layover')} onChange={v => setD('layover', v)} placeholder="1h 35m" />
          <Field label="Connects to" value={d('connects_to')} onChange={v => setD('connects_to', v)} placeholder="AY 1571" />
        </div>
      </SectionBox>
      <SectionBox label="Aircraft & Service">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Aircraft" value={d('aircraft')} onChange={v => setD('aircraft', v)} placeholder="Airbus A350-900" />
          <Field label="Fare class" value={d('fare_class')} onChange={v => setD('fare_class', v)} placeholder="Business" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Stops" value={d('stops')} onChange={v => setD('stops', v)} placeholder="nonstop" />
          <Field label="Distance" value={d('distance')} onChange={v => setD('distance', v)} placeholder="5,759 mi" />
          <Field label="Baggage" value={d('baggage')} onChange={v => setD('baggage', v)} placeholder="23 kg" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Meal" value={d('meal')} onChange={v => setD('meal', v)} placeholder="Yes / type" />
          <Field label="Entertainment" value={d('entertainment')} onChange={v => setD('entertainment', v)} placeholder="Yes / IFE" />
        </div>
      </SectionBox>
      <SectionBox label="Passengers">
        <TextArea label="Names" value={d('passengers')} onChange={v => setD('passengers', v)} placeholder="Antony Wuth, Nicole Wuth" />
        <TextArea label="Loyalty numbers" value={d('loyalty_info')} onChange={v => setD('loyalty_info', v)} placeholder="Antony (Loyalty …), Nicole (Loyalty …)" />
      </SectionBox>
      <SectionBox label="Booking">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="DYL7CY" />
          <Field label="Booked with" value={d('booking_airline')} onChange={v => setD('booking_airline', v)} placeholder="Qantas Airways" />
        </div>
        <Field label="Booking URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone" value={d('booking_phone')} onChange={v => setD('booking_phone', v)} placeholder="+61 2 9691 3636" />
          <Field label="Total cost" value={core.cost} onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="214.20 SGD" />
        </div>
      </SectionBox>
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

export const KIND_LABEL = {
  activity: 'Activity', restaurant: 'Restaurant', note: 'Note',
  accommodation: 'Accommodation', flight: 'Flight',
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
    setSaving(true); setError(null)
    try {
      const updated = await updateItem(item.id, { ...core, details })
      onSave(updated)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const color = KIND_VAR[core.kind] ?? 'var(--text-muted)'

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', maxHeight: '90vh' }}
        className="w-full max-w-lg rounded-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div style={{ borderBottom: '1px solid var(--border)' }} className="flex items-center gap-3 px-5 py-4">
          <select
            value={core.kind}
            onChange={e => setCore(c => ({ ...c, kind: e.target.value }))}
            style={{
              color,
              background: `color-mix(in srgb, ${color} 12%, transparent)`,
              border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
            }}
            className="text-xs px-2 py-1 rounded-full font-medium outline-none cursor-pointer"
          >
            {Object.keys(KIND_LABEL).map(k => (
              <option key={k} value={k} style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <span style={{ color: 'var(--text)' }} className="flex-1 text-sm font-medium truncate">{core.name || item.name}</span>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-faint)' }}
            className="hover:opacity-70 transition-opacity text-lg leading-none shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {core.kind === 'accommodation' ? (
            <AccommodationForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'flight' ? (
            <FlightForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : (
            <GenericForm core={core} setCore={setCore} />
          )}
          {error && <p style={{ color: 'var(--error)' }} className="text-xs mt-3">{error}</p>}
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} className="flex items-center justify-end gap-3 px-5 py-4">
          <button
            onClick={onClose}
            style={{ color: 'var(--text-faint)' }}
            className="text-sm hover:opacity-70 transition-opacity"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
