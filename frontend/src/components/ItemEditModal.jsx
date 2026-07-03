import { useState, useEffect, useRef } from 'react'
import { createItem, updateItem, enrichPlace, washLookup, uploadGpx, lookupAirline, fetchRouteElevation, fetchGeocode, deleteItem, routeDistance, routeToGpx, getItemStops, moveItem, generateRiverPath } from '../api.js'
import { setEditing } from '../editState.js'
import { KIND_VAR, KIND_LABEL, KIND_OPTIONS } from '../kinds.js'
import { parseCost, convertCurrency, getHomeCurrency } from '../currency.js'
import { fmtDay } from '../dates.js'
import RailLookupModal from './RailLookupModal.jsx'

// Parse a timezone field like "GMT+8", "UTC+5:30", "+08:00" → offset in minutes.
// Returns null if it can't be parsed (so we know whether TZ info is available).
function parseTzOffsetMin(tz) {
  if (!tz) return null
  const s = String(tz).trim().toUpperCase().replace(/\s+/g, '')
  const m = s.match(/^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0))
}

// "YYYY-MM-DDTHH:MM" → minutes since epoch, parsed as wall-clock (no local TZ shift).
function localToMin(s) {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000
}

function fmtDurationMin(mins) {
  if (mins == null || mins <= 0) return null
  const h = Math.floor(mins / 60), m = mins % 60
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

// Minutes between two local datetimes. If both TZ offsets are given the times are
// normalised to UTC first; otherwise the difference is taken as-is (wall-clock).
function durationBetween(departLocal, arriveLocal, departTz, arriveTz) {
  const dep = localToMin(departLocal), arr = localToMin(arriveLocal)
  if (dep == null || arr == null) return null
  const depOff = parseTzOffsetMin(departTz), arrOff = parseTzOffsetMin(arriveTz)
  const diff = (depOff != null && arrOff != null)
    ? (arr - arrOff) - (dep - depOff)
    : arr - dep
  return diff > 0 ? diff : null
}

// Calculate real road/path distance + duration via Google Routes API.
function DistanceButton({ points, mode, onResult, color = 'var(--accent)' }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  async function calc() {
    const pts = (points || []).filter(Boolean)
    if (busy) return
    if (pts.length < 2) { setMsg({ text: 'Add start and end first', color: 'var(--error)' }); return }
    setBusy(true); setMsg(null)
    try {
      const r = await routeDistance(pts, mode)
      onResult(r)
      setMsg({ text: `✓ ${r.distance_text}${r.duration_text ? ' · ' + r.duration_text : ''}`, color: 'var(--success)' })
    } catch (e) {
      setMsg({ text: e.message, color: 'var(--error)' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={calc}
        disabled={busy}
        style={{ color, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} 8%, transparent)` }}
        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity"
      >
        {busy ? 'Calculating…' : 'Calculate distance (Google)'}
      </button>
      {msg && <span className="text-xs" style={{ color: msg.color }}>{msg.text}</span>}
    </div>
  )
}

// Ordered route points for a distance lookup: full captured route if present, else start/end.
function routePointsOf(details) {
  if (details.route_points?.length >= 2) return details.route_points
  return [details.start_location, details.end_location].filter(Boolean)
}

// A datetime-local input only renders YYYY-MM-DDTHH:MM. Stored values can be
// date-only ("2026-08-16", e.g. from import) or have seconds / a space separator,
// which the input silently drops — making the field look empty. Coerce them.
function toLocalInput(v) {
  if (!v) return ''
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}` : ''
}

function Field({ label, value, onChange, placeholder, type = 'text', min }) {
  const displayValue = type === 'datetime-local' ? toLocalInput(value) : (value ?? '')
  // Constrain (and open) date/datetime pickers at `min` — e.g. an arrival/check-in
  // — so a departure can't be set earlier and the user doesn't scroll from today.
  const minValue = min ? (type === 'datetime-local' ? toLocalInput(min) : min) : undefined
  return (
    <div className="flex flex-col gap-0.5">
      <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">{label}</label>
      <input
        type={type}
        value={displayValue}
        min={minValue}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        // en-GB forces the native picker to render a 24-hour clock — the
        // browser otherwise follows the OS locale, which for many users
        // defaults to 12-hour AM/PM regardless of the page's own language.
        lang={(type === 'datetime-local' || type === 'time') ? 'en-GB' : undefined}
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

// ── Passenger / participant editor ────────────────────────────────────────────

const PASSENGER_FIELDS_BY_KIND = {
  flight: [
    { key: 'name',    label: 'Name',      placeholder: 'Mr Antony Wuth',   span: 2 },
    { key: 'ticket',  label: 'Ticket #',  placeholder: '081-2382295145' },
    { key: 'seat',    label: 'Seat',      placeholder: '14A' },
    { key: 'loyalty', label: 'Loyalty #', placeholder: 'QF 9657053' },
    { key: 'ff_tier', label: 'FF Tier',   placeholder: 'Bronze' },
    { key: 'meal',    label: 'Meal',      placeholder: 'Standard' },
    { key: 'baggage', label: 'Baggage',   placeholder: '23 kg' },
  ],
  rail: [
    { key: 'name',    label: 'Name',      placeholder: 'Mr Antony Wuth',   span: 2 },
    { key: 'ticket',  label: 'Ticket #',  placeholder: 'e-ticket ref' },
    { key: 'seat',    label: 'Seat',      placeholder: '14A' },
    { key: 'loyalty', label: 'Loyalty #', placeholder: 'Rail card #' },
    { key: 'meal',    label: 'Meal',      placeholder: 'Standard' },
  ],
  participants: [
    { key: 'name',   label: 'Name',     placeholder: 'Mr Antony Wuth' },
    { key: 'ticket', label: 'Ticket #', placeholder: 'TKT-001' },
    { key: 'seat',   label: 'Seat',     placeholder: 'F12' },
  ],
}

function PassengerEditor({ details, setDetails, kind }) {
  const isParticipants = kind !== 'flight' && kind !== 'rail'
  const field = isParticipants ? 'participants' : 'passengers'
  const raw = details[field]
  const fields = PASSENGER_FIELDS_BY_KIND[isParticipants ? 'participants' : kind] ?? PASSENGER_FIELDS_BY_KIND.flight

  // Legacy string format — show old textareas unchanged
  if (typeof raw === 'string') {
    return (
      <SectionBox label="Passengers">
        <TextArea label="Names" value={details.passengers ?? ''} onChange={v => setDetails(d => ({ ...d, passengers: v }))} placeholder="Antony Wuth, Nicole Wuth" />
        <TextArea label="Loyalty numbers" value={details.loyalty_info ?? ''} onChange={v => setDetails(d => ({ ...d, loyalty_info: v }))} placeholder="QF 9657053, QF 4419892" />
      </SectionBox>
    )
  }

  const passengers = Array.isArray(raw) ? raw : []

  function update(i, key, val) {
    const next = passengers.map((p, j) => j === i ? { ...p, [key]: val || undefined } : p)
    setDetails(d => ({ ...d, [field]: next }))
  }

  function add() {
    setDetails(d => ({ ...d, [field]: [...passengers, {}] }))
  }

  function remove(i) {
    const next = passengers.filter((_, j) => j !== i)
    setDetails(d => ({ ...d, [field]: next.length ? next : undefined }))
  }

  const sectionLabel = isParticipants ? 'Participants' : 'Passengers'

  return (
    <SectionBox label={sectionLabel}>
      <div className="space-y-3">
        {passengers.map((p, i) => (
          <div
            key={i}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0.5rem' }}
            className="p-3 space-y-2"
          >
            <div className="flex justify-between items-center">
              <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">
                {isParticipants ? 'Person' : 'Passenger'} {i + 1}
              </span>
              <button
                type="button"
                onClick={() => remove(i)}
                style={{ color: 'var(--error)' }}
                className="text-xs hover:opacity-70 transition-opacity"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {fields.map(f => (
                <div key={f.key} className={f.span === 2 ? 'col-span-2' : ''}>
                  <Field
                    label={f.label}
                    value={p[f.key] ?? ''}
                    onChange={v => update(i, f.key, v)}
                    placeholder={f.placeholder}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
        className="w-full py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity mt-1"
      >
        + Add {isParticipants ? 'person' : 'passenger'}
      </button>
    </SectionBox>
  )
}

function AutoFillButton({ enriching, enrichMsg, onClick, disabled = false }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={enriching || disabled}
        style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
        className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity"
        title={disabled ? 'Enter a name first' : 'Auto-fill empty fields from Google Places'}
      >
        {enriching ? '…' : 'Auto-fill'}
      </button>
      {enrichMsg && (
        <span className="text-xs" style={{ color: enrichMsg.color }}>{enrichMsg.text}</span>
      )}
    </div>
  )
}

function AccommodationForm({ itemId, stopId, core, details, setCore, setDetails }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)
  const [washing, setWashing] = useState(false)
  const [washMsg, setWashMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  async function autoFill() {
    if (enriching || !core.name.trim()) return
    setEnriching(true)
    setEnrichMsg(null)
    try {
      const suggestions = await enrichPlace(stopId, { kind: 'accommodation', name: core.name, location: details.location })
      let filled = 0
      if (suggestions.location && !details.location) { setD('location', suggestions.location); filled++ }
      if (suggestions.contact_phone && !details.contact_phone) { setD('contact_phone', suggestions.contact_phone); filled++ }
      if (suggestions.website && !core.link) { setCore(c => ({ ...c, link: suggestions.website })); filled++ }
      if (suggestions.description && !details.description) { setD('description', suggestions.description); filled++ }
      setEnrichMsg(filled
        ? { text: `${filled} field${filled > 1 ? 's' : ''} filled`, color: 'var(--success)' }
        : { text: 'Nothing to add', color: 'var(--text-faint)' })
    } catch (e) {
      setEnrichMsg({ text: e.message, color: 'var(--error)' })
    } finally {
      setEnriching(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Hotel Roma" />
        </div>
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} disabled={!core.name.trim()} />
      </div>
      <Field label="Location / Address" value={d('location')} onChange={v => setD('location', v)} placeholder="Via Nazionale 7, Rome" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Check-in" type="datetime-local" value={d('checkin')} onChange={v => setD('checkin', v)} />
        <Field label="Check-out" type="datetime-local" value={d('checkout')} onChange={v => setD('checkout', v)} min={d('checkin')} />
      </div>
      <Field label="Bag drop" type="datetime-local" value={d('bag_drop')} onChange={v => setD('bag_drop', v)} />
      <Field label="Booking confirmation" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="ABC123XYZ" />
      <SectionBox label="Contact">
        <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+39 06 123456" />
        <Field label="Website" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
        <Field label="Email" value={d('contact_email')} onChange={v => setD('contact_email', v)} placeholder="info@hotel.com" />
      </SectionBox>
      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="Breakfast included, rooftop terrace…" />
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="…" />

      <SectionBox label="Laundry">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!details.hotel_laundry}
            onChange={e => setD('hotel_laundry', e.target.checked || undefined)}
            className="rounded"
          />
          <span style={{ color: 'var(--text-muted)' }} className="text-sm">Hotel offers laundry service</span>
        </label>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={washing || !itemId}
            onClick={async () => {
              setWashing(true); setWashMsg(null)
              try {
                const updated = await washLookup(itemId, details.location || '')
                const count = (updated.details?.washing ?? []).length
                setD('washing', updated.details?.washing ?? [])
                setWashMsg({ text: `${count} laundromat${count !== 1 ? 's' : ''} found nearby`, color: 'var(--success)' })
              } catch (e) {
                setWashMsg({ text: e.message, color: 'var(--error)' })
              } finally { setWashing(false) }
            }}
            style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
            className="px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity text-left"
          >
            {washing ? '🔍 Searching…' : '🔍 Find nearby laundromats'}
          </button>
          {washMsg && <span className="text-xs" style={{ color: washMsg.color }}>{washMsg.text}</span>}
          {Array.isArray(details.washing) && details.washing.length > 0 && (
            <span style={{ color: 'var(--text-faint)' }} className="text-xs">
              {details.washing.length} laundromat{details.washing.length !== 1 ? 's' : ''} stored
              {details.washing.filter(w => w.top_pick).map(w => ` · Top pick: ${w.name}`)[0] ?? ''}
            </span>
          )}
        </div>
      </SectionBox>
    </div>
  )
}

const BOOKING_STATUS = ['planned', 'booked', 'confirmed']

function RestaurantForm({ itemId, stopId, core, details, setCore, setDetails }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  // Split scheduled_at into separate date and time inputs
  const [resDate, setResDate] = useState(() => core.scheduled_at?.split('T')[0] ?? '')
  const [resTime, setResTime] = useState(() => {
    const tp = core.scheduled_at?.split('T')[1]?.slice(0, 5)
    if (tp && tp !== '00:00') return tp
    return details.reservation_time ?? ''
  })

  function applyDateTime(date, time) {
    if (date && time) {
      setCore(c => ({ ...c, scheduled_at: `${date}T${time}` }))
      setDetails(({ reservation_time: _, ...rest }) => rest)
    } else if (date) {
      setCore(c => ({ ...c, scheduled_at: `${date}T00:00` }))
      setDetails(({ reservation_time: _, ...rest }) => rest)
    } else if (time) {
      setCore(c => ({ ...c, scheduled_at: null }))
      setD('reservation_time', time)
    } else {
      setCore(c => ({ ...c, scheduled_at: null }))
      setDetails(({ reservation_time: _, ...rest }) => rest)
    }
  }

  async function autoFill() {
    if (enriching || !core.name.trim()) return
    setEnriching(true)
    setEnrichMsg(null)
    try {
      const suggestions = await enrichPlace(stopId, { kind: 'restaurant', name: core.name, location: details.location })
      let filled = 0
      if (suggestions.location && !details.location) { setD('location', suggestions.location); filled++ }
      if (suggestions.contact_phone && !details.contact_phone) { setD('contact_phone', suggestions.contact_phone); filled++ }
      if (suggestions.website && !core.link) { setCore(c => ({ ...c, link: suggestions.website })); filled++ }
      setEnrichMsg(filled
        ? { text: `${filled} field${filled > 1 ? 's' : ''} filled`, color: 'var(--success)' }
        : { text: 'Nothing to add', color: 'var(--text-faint)' })
    } catch (e) {
      setEnrichMsg({ text: e.message, color: 'var(--error)' })
    } finally {
      setEnriching(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Trattoria da Mario" />
        </div>
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} disabled={!core.name.trim()} />
      </div>
      <Field label="Address" value={d('location')} onChange={v => setD('location', v)} placeholder="Via della Croce 3, Rome" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+39 06 123456" />
        <Field label="Website" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="OpenTable #123" />
        <div className="flex flex-col gap-0.5">
          <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Booking status</label>
          <select
            value={d('booking_status') || 'planned'}
            onChange={e => setD('booking_status', e.target.value)}
            style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
            className="rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)] capitalize"
          >
            {BOOKING_STATUS.map(s => (
              <option key={s} value={s} style={{ background: 'var(--modal-bg)' }}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" type="date" value={resDate}
          onChange={v => { setResDate(v); applyDateTime(v, resTime) }} />
        <Field label="Time" type="time" value={resTime}
          onChange={v => { setResTime(v); applyDateTime(resDate, v) }} />
      </div>
      <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Dietary needs…" />
    </div>
  )
}

function FlightForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  // Changing a time or TZ recomputes duration live — but only when both timezones
  // are known, since a naive cross-zone diff would be wrong.
  const setTimed = (key, val) => setDetails(prev => {
    const next = { ...prev, [key]: val }
    if (parseTzOffsetMin(next.depart_tz) != null && parseTzOffsetMin(next.arrive_tz) != null) {
      const dur = fmtDurationMin(durationBetween(next.depart_time, next.arrive_time, next.depart_tz, next.arrive_tz))
      if (dur) next.duration = dur
    }
    return next
  })
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupMsg, setLookupMsg]   = useState(null)

  async function doAirlineLookup() {
    const flightNum = d('flight_number').trim()
    const m = flightNum.match(/^([A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])/i)
    if (!m) { setLookupMsg({ text: 'Enter a flight number first (e.g. AY 132)', color: 'var(--error)' }); return }
    setLookupBusy(true); setLookupMsg(null)
    try {
      const res = await lookupAirline(m[1].toUpperCase())
      setD('airline', res.name)
      setLookupMsg({ text: `✓ ${res.name}`, color: 'var(--success)' })
    } catch (e) {
      setLookupMsg({ text: e.message, color: 'var(--error)' })
    } finally {
      setLookupBusy(false)
    }
  }

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
          <div className="flex flex-col gap-0.5">
            <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Airline</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={d('airline')}
                onChange={e => setD('airline', e.target.value)}
                placeholder="Finnair"
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
              <button
                type="button"
                onClick={doAirlineLookup}
                disabled={lookupBusy}
                style={{ color: 'var(--kind-flight)', border: '1px solid color-mix(in srgb, var(--kind-flight) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-flight) 8%, transparent)' }}
                className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity"
              >
                {lookupBusy ? '…' : 'Lookup'}
              </button>
            </div>
            {lookupMsg && <span className="text-xs mt-0.5" style={{ color: lookupMsg.color }}>{lookupMsg.text}</span>}
          </div>
        </div>
      </SectionBox>
      <SectionBox label="Schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Departs" type="datetime-local" value={d('depart_time')} onChange={v => setTimed('depart_time', v)} />
          <Field label="Arrives" type="datetime-local" value={d('arrive_time')} onChange={v => setTimed('arrive_time', v)} min={d('depart_time')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dep terminal" value={d('origin_terminal')} onChange={v => setD('origin_terminal', v)} placeholder="1" />
          <Field label="Arr terminal" value={d('arrive_terminal')} onChange={v => setD('arrive_terminal', v)} placeholder="2B" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dep gate" value={d('origin_gate')} onChange={v => setD('origin_gate', v)} placeholder="D12" />
          <Field label="Arr gate" value={d('arrive_gate')} onChange={v => setD('arrive_gate', v)} placeholder="23" />
        </div>
        <Field label="Check-in desk" value={d('checkin_desk')} onChange={v => setD('checkin_desk', v)} placeholder="D5–D20" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Depart TZ" value={d('depart_tz')} onChange={v => setTimed('depart_tz', v)} placeholder="GMT+8" />
          <Field label="Arrive TZ" value={d('arrive_tz')} onChange={v => setTimed('arrive_tz', v)} placeholder="GMT+3" />
        </div>
        <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="13h 25m" />
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stops" value={d('stops')} onChange={v => setD('stops', v)} placeholder="nonstop" />
          <Field label="Distance" value={d('distance')} onChange={v => setD('distance', v)} placeholder="5,759 mi" />
        </div>
        <Field label="Entertainment" value={d('entertainment')} onChange={v => setD('entertainment', v)} placeholder="Yes / IFE" />
      </SectionBox>
      <PassengerEditor kind="flight" details={details} setDetails={setDetails} />
      <SectionBox label="Booking">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="DYL7CY" />
          <Field label="Booked with" value={d('booking_airline')} onChange={v => setD('booking_airline', v)} placeholder="Qantas Airways" />
        </div>
        <Field label="Booking URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone" value={d('booking_phone')} onChange={v => setD('booking_phone', v)} placeholder="+61 2 9691 3636" />
        </div>
      </SectionBox>
      <SectionBox label="Online check-in">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Window before departure" value={d('checkin_window')} onChange={v => setD('checkin_window', v)} placeholder="48h" />
          <Field label="Check-in URL" value={d('checkin_url')} onChange={v => setD('checkin_url', v)} placeholder="https://…" />
        </div>
      </SectionBox>
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="…" />
    </div>
  )
}

function ActivityForm({ itemId, stopId, core, details, setCore, setDetails }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  async function autoFill() {
    if (enriching || !core.name.trim()) return
    setEnriching(true)
    setEnrichMsg(null)
    try {
      const suggestions = await enrichPlace(stopId, { kind: 'activity', name: core.name, location: details.location })
      let filled = 0
      if (suggestions.location && !details.location) { setD('location', suggestions.location); filled++ }
      if (suggestions.contact_phone && !details.contact_phone) { setD('contact_phone', suggestions.contact_phone); filled++ }
      if (suggestions.website && !core.link) { setCore(c => ({ ...c, link: suggestions.website })); filled++ }
      if (suggestions.description && !details.description) { setD('description', suggestions.description); filled++ }
      setEnrichMsg(filled
        ? { text: `${filled} field${filled > 1 ? 's' : ''} filled`, color: 'var(--success)' }
        : { text: 'Nothing to add', color: 'var(--text-faint)' })
    } catch (e) {
      setEnrichMsg({ text: e.message, color: 'var(--error)' })
    } finally {
      setEnriching(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Activity name" />
        </div>
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} disabled={!core.name.trim()} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date & time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />
        <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="2h 30m" />
      </div>
      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="What it is, what to expect…" rows={3} />
      <Field label="Address" value={d('location')} onChange={v => setD('location', v)} placeholder="123 Main St, City" />
      <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+1 234 567 8900" />
      <Field label="Website" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Notes…" />
    </div>
  )
}

function ShowForm({ itemId, stopId, core, details, setCore, setDetails }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  async function autoFill() {
    if (enriching || !core.name.trim()) return
    setEnriching(true); setEnrichMsg(null)
    try {
      const suggestions = await enrichPlace(stopId, { kind: 'show', name: core.name, location: details.location })
      let filled = 0
      if (suggestions.location && !details.location) { setD('location', suggestions.location); filled++ }
      if (suggestions.contact_phone && !details.contact_phone) { setD('contact_phone', suggestions.contact_phone); filled++ }
      if (suggestions.website && !core.link) { setCore(c => ({ ...c, link: suggestions.website })); filled++ }
      if (suggestions.description && !details.description) { setD('description', suggestions.description); filled++ }
      setEnrichMsg(filled
        ? { text: `${filled} field${filled > 1 ? 's' : ''} filled`, color: 'var(--success)' }
        : { text: 'Nothing to add', color: 'var(--text-faint)' })
    } catch (e) {
      setEnrichMsg({ text: e.message, color: 'var(--error)' })
    } finally {
      setEnriching(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Show / performance name" />
        </div>
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} disabled={!core.name.trim()} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />
        <Field label="Doors / duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="Doors 19:00 · 2h" />
      </div>
      <Field label="Venue" value={d('location')} onChange={v => setD('location', v)} placeholder="Théâtre du Châtelet, Paris" />
      <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="ABC123" />
      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="What's on, performers…" rows={3} />
      <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+33 1 23 45 67 89" />
      <Field label="Website / tickets URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Notes…" />
      <PassengerEditor kind="show" details={details} setDetails={setDetails} />
    </div>
  )
}

const HIRE_VEHICLE_TYPES = ['car', 'bike', 'scooter', 'van', 'motorcycle']

function HireForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  return (
    <div className="space-y-3">
      <Field label="Name / description" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Bike hire — Lyon" />
      <div className="flex flex-col gap-0.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Vehicle type</label>
        <div className="flex flex-wrap gap-2">
          {HIRE_VEHICLE_TYPES.map(vt => (
            <button
              key={vt} type="button"
              onClick={() => setD('vehicle_type', vt)}
              style={{
                color: d('vehicle_type') === vt ? 'var(--kind-hire)' : 'var(--text-faint)',
                border: `1px solid ${d('vehicle_type') === vt ? 'var(--kind-hire)' : 'var(--border)'}`,
                background: d('vehicle_type') === vt ? 'color-mix(in srgb, var(--kind-hire) 12%, transparent)' : 'transparent',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors"
            >{vt}</button>
          ))}
        </div>
      </div>
      <Field label="Provider" value={d('provider')} onChange={v => setD('provider', v)} placeholder="Vélo'v, Enterprise, Hertz…" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Pick-up" type="datetime-local" value={d('pickup_time')} onChange={v => setD('pickup_time', v)} />
        <Field label="Drop-off" type="datetime-local" value={d('dropoff_time')} onChange={v => setD('dropoff_time', v)} />
      </div>
      <Field label="Pick-up location" value={d('pickup_location')} onChange={v => setD('pickup_location', v)} placeholder="Station / depot address" />
      <Field label="Drop-off location" value={d('dropoff_location')} onChange={v => setD('dropoff_location', v)} placeholder="Leave blank if same as pick-up" />
      <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="ABC123" />
      <Field label="Booking URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="…" />
    </div>
  )
}

function GenericForm({ core, details, setCore, setDetails }) {
  const important = !!details?.important
  return (
    <div className="space-y-3">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Note title" />
      <Field label="Date & time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Notes…" rows={3} />
      <Field label="Link" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <button
        type="button"
        onClick={() => setDetails(d => ({ ...d, important: important ? undefined : true }))}
        style={{
          color: important ? 'var(--warning)' : 'var(--text-faint)',
          border: `1px solid ${important ? 'var(--warning)' : 'var(--border)'}`,
          background: important ? 'color-mix(in srgb, var(--warning) 12%, transparent)' : 'transparent',
        }}
        className="w-full px-3 py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition-colors"
      >
        {important ? '📌 Important — pinned to top' : 'Flag as important (pin to top)'}
      </button>
    </div>
  )
}

const DIFFICULTY = ['easy', 'moderate', 'hard', 'strenuous']

function WalkForm({ itemId, core, details, setCore, setDetails }) {
  const [mapsUrl, setMapsUrl] = useState('')
  const [mapsMsg, setMapsMsg] = useState(null)
  const [gpxBusy, setGpxBusy] = useState(false)
  const [gpxMsg, setGpxMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  async function handleGpx(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setGpxBusy(true); setGpxMsg(null)
    try {
      const updated = await uploadGpx(itemId, file)
      setDetails(updated.details ?? {})
      setGpxMsg({ text: `✓ ${file.name} uploaded`, color: 'var(--success)' })
    } catch (err) {
      setGpxMsg({ text: err.message, color: 'var(--error)' })
    } finally {
      setGpxBusy(false)
      e.target.value = ''
    }
  }
  const diff = d('difficulty')

  async function extractMaps() {
    const res = parseMapsUrl(mapsUrl)
    if (!res) { setMapsMsg({ text: 'Could not parse this URL', color: 'var(--error)' }); return }
    setMapsMsg({ text: 'Extracting…', color: 'var(--text-faint)' })
    let filled = 0
    if (res.start && !details.start_location) { setD('start_location', res.start); filled++ }
    if (res.end   && !details.end_location)   { setD('end_location',   res.end);   filled++ }
    if (mapsUrl) { setD('maps_url', mapsUrl) }
    // Store the full ordered route (incl. intermediate waypoints) for the map.
    if (res.waypoints && res.waypoints.length > 2) { setD('route_points', res.waypoints); filled++ }

    // middle must be defined before the await so geocodeForRoute can use it for validation
    const middle = res.allCoords ?? []

    // Geocode named start/end in parallel; validate each against route coords
    // so a business name matched in the wrong city gets rejected.
    const needsGeocode = (!res.startCoords && res.start) || (!res.endCoords && res.end)
    if (needsGeocode) setMapsMsg({ text: 'Locating start & end…', color: 'var(--text-faint)' })

    const [startResult, endResult] = await Promise.all([
      (!res.startCoords && res.start) ? geocodeForRoute(res.start, middle) : Promise.resolve(null),
      (!res.endCoords   && res.end)   ? geocodeForRoute(res.end,   middle) : Promise.resolve(null),
    ])
    const startC = res.startCoords ?? startResult
    const endC   = res.endCoords   ?? endResult

    // Build the full coordinate chain.
    // Named start/end are NOT in allCoords; coord start/end ARE already in allCoords.
    const chain = [
      ...(startC && !res.startCoords ? [startC] : []),
      ...middle,
      ...(endC   && !res.endCoords   ? [endC]   : []),
    ]

    if (!details.distance && chain.length >= 2) {
      const km = chain.reduce((sum, c, i) => i === 0 ? 0 : sum + haversineKm(chain[i - 1], c), 0)
      setD('distance', `~${km.toFixed(1)} km`)
      filled++
    }

    // Show distance result now; elevation may take a few more seconds
    const elevStart = startC ?? chain[0]
    const elevEnd   = endC   ?? chain[chain.length - 1]
    if (elevStart && elevEnd && !details.elevation_gain && !details.elevation_loss) {
      setMapsMsg({ text: `${filled} field${filled > 1 ? 's' : ''} filled — fetching elevation…`, color: 'var(--text-faint)' })
      try {
        const elev = await fetchRouteElevation(
          elevStart.lat, elevStart.lng, elevEnd.lat, elevEnd.lng,
        )
        const gain = Math.round(Math.max(0, elev.end_elevation - elev.start_elevation))
        const loss = Math.round(Math.max(0, elev.start_elevation - elev.end_elevation))
        if (gain > 0) { setD('elevation_gain', `${gain} m`); filled++ }
        if (loss > 0) { setD('elevation_loss', `${loss} m`); filled++ }
      } catch {}
    }

    setMapsMsg(filled
      ? { text: `${filled} field${filled > 1 ? 's' : ''} filled (estimates)`, color: 'var(--success)' }
      : { text: 'Nothing to add (fields already filled)', color: 'var(--text-faint)' })
  }

  return (
    <div className="space-y-4">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Coastal trail" />
      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="Route overview, highlights…" rows={2} />
      <Field label="Date & time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />

      <SectionBox label="Import from Google Maps">
        <div className="flex gap-2">
          <input
            value={mapsUrl}
            onChange={e => setMapsUrl(e.target.value)}
            placeholder="Paste directions URL…"
            style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button type="button" onClick={extractMaps}
            style={{ color: 'var(--kind-walk)', border: '1px solid color-mix(in srgb, var(--kind-walk) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-walk) 8%, transparent)' }}
            className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity">
            Extract
          </button>
        </div>
        {mapsMsg && <p className="text-xs mt-1" style={{ color: mapsMsg.color }}>{mapsMsg.text}</p>}
      </SectionBox>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Start" value={d('start_location')} onChange={v => setD('start_location', v)} placeholder="Trailhead / town" />
        <Field label="End"   value={d('end_location')}   onChange={v => setD('end_location',   v)} placeholder="Summit / finish" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Distance"   value={d('distance')}       onChange={v => setD('distance', v)}       placeholder="12 km" />
        <Field label="Elev ↑"     value={d('elevation_gain')} onChange={v => setD('elevation_gain', v)} placeholder="600 m" />
        <Field label="Elev ↓"     value={d('elevation_loss')} onChange={v => setD('elevation_loss', v)} placeholder="400 m" />
      </div>
      <DistanceButton points={routePointsOf(details)} mode="walk" color="var(--kind-walk)"
        onResult={r => {
          if (r.distance_text) setD('distance', r.distance_text)
          if (r.duration_text) setD('duration', r.duration_text)
          if (r.elevation_gain_text) setD('elevation_gain', r.elevation_gain_text)
          if (r.elevation_loss_text) setD('elevation_loss', r.elevation_loss_text)
        }} />
      <div className="flex flex-col gap-1.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Difficulty</label>
        <div className="flex gap-2 flex-wrap">
          {DIFFICULTY.map(s => (
            <button key={s} type="button" onClick={() => setD('difficulty', diff === s ? '' : s)}
              style={{
                color: diff === s ? 'var(--kind-walk)' : 'var(--text-faint)',
                border: `1px solid ${diff === s ? 'var(--kind-walk)' : 'var(--border)'}`,
                background: diff === s ? 'color-mix(in srgb, var(--kind-walk) 12%, transparent)' : 'transparent',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors">
              {s}
            </button>
          ))}
        </div>
      </div>
      <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="3h 30m" />
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Trail conditions, gear needed…" />

      <div className="flex flex-col gap-1.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">GPX File</label>
        <div className="flex items-center gap-3">
          <label style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', cursor: gpxBusy ? 'default' : 'pointer', opacity: gpxBusy ? 0.5 : 1 }}
            className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity">
            {gpxBusy ? 'Uploading…' : d('gpx_filename') ? 'Replace GPX' : 'Upload GPX'}
            <input type="file" accept=".gpx,application/gpx+xml" onChange={handleGpx} disabled={gpxBusy} className="hidden" />
          </label>
          {gpxMsg && <span className="text-xs" style={{ color: gpxMsg.color }}>{gpxMsg.text}</span>}
          {!gpxMsg && d('original_gpx_name') && (
            <span className="text-xs" style={{ color: 'var(--text-faint)' }}>{d('original_gpx_name')}</span>
          )}
        </div>
        {d('gpx_filename') && !gpxMsg && (
          <p style={{ color: 'var(--text-faint)' }} className="text-xs">Stats auto-extracted — edit above if needed</p>
        )}
      </div>
    </div>
  )
}

const TOUR_TYPES = ['private', 'small group', 'large group', 'self-guided']

function TourForm({ itemId, stopId, core, details, setCore, setDetails }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  const tourType = d('tour_type')

  async function autoFill() {
    if (enriching || !core.name.trim()) return
    setEnriching(true); setEnrichMsg(null)
    try {
      const suggestions = await enrichPlace(stopId, { kind: 'tour', name: core.name, location: details.meeting_point })
      let filled = 0
      if (suggestions.location && !details.meeting_point) { setD('meeting_point', suggestions.location); filled++ }
      if (suggestions.contact_phone && !details.contact_phone) { setD('contact_phone', suggestions.contact_phone); filled++ }
      if (suggestions.website && !core.link) { setCore(c => ({ ...c, link: suggestions.website })); filled++ }
      setEnrichMsg(filled
        ? { text: `${filled} field${filled > 1 ? 's' : ''} filled`, color: 'var(--success)' }
        : { text: 'Nothing to add', color: 'var(--text-faint)' })
    } catch (e) {
      setEnrichMsg({ text: e.message, color: 'var(--error)' })
    } finally {
      setEnriching(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Vatican Museums Tour" />
        </div>
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} disabled={!core.name.trim()} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date & time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />
        <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="3 hours" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Tour type</label>
        <div className="flex gap-2 flex-wrap">
          {TOUR_TYPES.map(t => (
            <button key={t} type="button" onClick={() => setD('tour_type', tourType === t ? '' : t)}
              style={{
                color: tourType === t ? 'var(--kind-tour)' : 'var(--text-faint)',
                border: `1px solid ${tourType === t ? 'var(--kind-tour)' : 'var(--border)'}`,
                background: tourType === t ? 'color-mix(in srgb, var(--kind-tour) 12%, transparent)' : 'transparent',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors">
              {t}
            </button>
          ))}
        </div>
      </div>

      <Field label="Meeting point" value={d('meeting_point')} onChange={v => setD('meeting_point', v)} placeholder="Main entrance, St Peter's Square" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Operator / guide" value={d('operator')} onChange={v => setD('operator', v)} placeholder="GetYourGuide, local guide…" />
        <Field label="Language" value={d('language')} onChange={v => setD('language', v)} placeholder="English" />
      </div>

      <SectionBox label="Booking">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="GYG-12345" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Per person" value={d('cost_per_person')} onChange={v => setD('cost_per_person', v)} placeholder="€40" />
          <Field label="Group size" value={d('group_size')} onChange={v => setD('group_size', v)} placeholder="2 people" />
        </div>
        <Field label="Booking URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
        <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+39 06 123456" />
      </SectionBox>

      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="What's included, bring ID, wear comfortable shoes…" />
    </div>
  )
}


const VEHICLE_TYPES = ['car', 'taxi', 'minibus', 'bus', 'shuttle', 'private car']

function TransferForm({ core, details, setCore, setDetails }) {
  const [mapsUrl, setMapsUrl] = useState('')
  const [mapsMsg, setMapsMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  const vehicle = d('vehicle_type')

  async function extractMaps() {
    const res = parseMapsUrl(mapsUrl)
    if (!res) { setMapsMsg({ text: 'Could not parse this URL', color: 'var(--error)' }); return }
    setMapsMsg({ text: 'Extracting…', color: 'var(--text-faint)' })
    let filled = 0
    if (res.start && !details.start_location) { setD('start_location', res.start); filled++ }
    if (res.end   && !details.end_location)   { setD('end_location',   res.end);   filled++ }
    if (mapsUrl) { setD('maps_url', mapsUrl) }
    if (res.waypoints && res.waypoints.length > 2) { setD('route_points', res.waypoints); filled++ }

    const middle = res.allCoords ?? []
    if ((!res.startCoords && res.start) || (!res.endCoords && res.end))
      setMapsMsg({ text: 'Locating start & end…', color: 'var(--text-faint)' })

    const [startResult, endResult] = await Promise.all([
      (!res.startCoords && res.start) ? geocodeForRoute(res.start, middle) : Promise.resolve(null),
      (!res.endCoords   && res.end)   ? geocodeForRoute(res.end,   middle) : Promise.resolve(null),
    ])
    const startC = res.startCoords ?? startResult
    const endC   = res.endCoords   ?? endResult

    const chain = [
      ...(startC && !res.startCoords ? [startC] : []),
      ...middle,
      ...(endC && !res.endCoords ? [endC] : []),
    ]
    if (!details.distance && chain.length >= 2) {
      const km = chain.reduce((sum, c, i) => i === 0 ? 0 : sum + haversineKm(chain[i - 1], c), 0)
      setD('distance', `~${km.toFixed(1)} km`)
      filled++
    }

    setMapsMsg(filled
      ? { text: `${filled} field${filled > 1 ? 's' : ''} filled (estimates)`, color: 'var(--success)' }
      : { text: 'Nothing to add (fields already filled)', color: 'var(--text-faint)' })
  }

  return (
    <div className="space-y-4">
      <Field label="Description" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Hotel to airport" />
      <Field label="Pickup time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />

      <div className="flex flex-col gap-1.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Vehicle</label>
        <div className="flex gap-2 flex-wrap">
          {VEHICLE_TYPES.map(v => (
            <button key={v} type="button" onClick={() => setD('vehicle_type', vehicle === v ? '' : v)}
              style={{
                color: vehicle === v ? 'var(--kind-transfer)' : 'var(--text-faint)',
                border: `1px solid ${vehicle === v ? 'var(--kind-transfer)' : 'var(--border)'}`,
                background: vehicle === v ? 'color-mix(in srgb, var(--kind-transfer) 12%, transparent)' : 'transparent',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors">
              {v}
            </button>
          ))}
        </div>
      </div>

      <SectionBox label="Import from Google Maps">
        <div className="flex gap-2">
          <input
            value={mapsUrl}
            onChange={e => setMapsUrl(e.target.value)}
            placeholder="Paste directions URL…"
            style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button type="button" onClick={extractMaps}
            style={{ color: 'var(--kind-transfer)', border: '1px solid color-mix(in srgb, var(--kind-transfer) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-transfer) 8%, transparent)' }}
            className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity">
            Extract
          </button>
        </div>
        {mapsMsg && <p className="text-xs mt-1" style={{ color: mapsMsg.color }}>{mapsMsg.text}</p>}
      </SectionBox>

      <div className="grid grid-cols-2 gap-3">
        <Field label="From" value={d('start_location')} onChange={v => setD('start_location', v)} placeholder="Hotel / address" />
        <Field label="To"   value={d('end_location')}   onChange={v => setD('end_location',   v)} placeholder="Airport / address" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Distance"  value={d('distance')} onChange={v => setD('distance', v)} placeholder="45 km" />
        <Field label="Duration"  value={d('duration')} onChange={v => setD('duration', v)} placeholder="1h 15m" />
      </div>
      <DistanceButton points={routePointsOf(details)} mode="transfer" color="var(--kind-transfer)"
        onResult={r => { if (r.distance_text) setD('distance', r.distance_text); if (r.duration_text) setD('duration', r.duration_text) }} />
      <Field label="Per person" value={d('cost_per_person')} onChange={v => setD('cost_per_person', v)} placeholder="€30" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Booking ref" value={d('booking_ref')}    onChange={v => setD('booking_ref', v)}    placeholder="CONF123" />
        <Field label="Provider"    value={d('provider')}        onChange={v => setD('provider', v)}        placeholder="Local taxis" />
      </div>
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Meet at hotel lobby, driver name…" />
    </div>
  )
}

const RIVER_VEHICLE_TYPES = ['ferry', 'boat', 'riverboat', 'water taxi']

function RiverTransferForm({ core, details, setCore, setDetails }) {
  const [pathMsg, setPathMsg] = useState(null)
  const [generating, setGenerating] = useState(false)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  // Changing a time recomputes duration live, same as RailForm.
  const setTimed = (key, val) => setDetails(prev => {
    const next = { ...prev, [key]: val }
    const dur = fmtDurationMin(durationBetween(next.depart_time, next.arrive_time))
    if (dur) next.duration = dur
    return next
  })
  // A stale path silently showing the wrong route is worse than no map at
  // all — clear the generated path if the user edits the endpoints or river
  // name after one was already generated.
  const setLocation = (key, val) => setDetails(prev => {
    const next = { ...prev, [key]: val }
    if (prev.river_path?.length) {
      delete next.river_path
      delete next.river_path_approximate
      delete next.river_path_generated_at
    }
    return next
  })
  const vehicle = d('vehicle_type')

  async function handleGeneratePath() {
    if (!d('start_location') || !d('end_location')) return
    setGenerating(true)
    setPathMsg({ text: 'Estimating river path…', color: 'var(--text-faint)' })
    try {
      const res = await generateRiverPath([d('start_location'), d('end_location')], d('river_name'))
      setDetails(prev => ({
        ...prev,
        river_path: res.path,
        river_path_approximate: res.approximate,
        river_path_generated_at: new Date().toISOString(),
        distance: prev.distance || (res.distance_km ? `~${res.distance_km.toFixed(1)} km` : prev.distance),
      }))
      setPathMsg(res.approximate
        ? { text: 'No river route found — using a straight line instead (approximate, not a detected waterway)', color: 'var(--warning)' }
        : {
            text: `Path generated (${res.path.length} points)${res.river_name_used ? ` along the ${res.river_name_used}` : ''}`,
            color: 'var(--success)',
          })
    } catch (e) {
      setPathMsg({ text: e.message || 'Could not generate a river path', color: 'var(--error)' })
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Description" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Lyon to Valence" />

      <div className="flex flex-col gap-1.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Vessel</label>
        <div className="flex gap-2 flex-wrap">
          {RIVER_VEHICLE_TYPES.map(v => (
            <button key={v} type="button" onClick={() => setD('vehicle_type', vehicle === v ? '' : v)}
              style={{
                color: vehicle === v ? 'var(--kind-river_transfer)' : 'var(--text-faint)',
                border: `1px solid ${vehicle === v ? 'var(--kind-river_transfer)' : 'var(--border)'}`,
                background: vehicle === v ? 'color-mix(in srgb, var(--kind-river_transfer) 12%, transparent)' : 'transparent',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors">
              {v}
            </button>
          ))}
        </div>
      </div>

      <SectionBox label="Schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Departs" type="datetime-local" value={d('depart_time')} onChange={v => setTimed('depart_time', v)} />
          <Field label="Arrives" type="datetime-local" value={d('arrive_time')} onChange={v => setTimed('arrive_time', v)} min={d('depart_time')} />
        </div>
      </SectionBox>

      <div className="grid grid-cols-2 gap-3">
        <Field label="From" value={d('start_location')} onChange={v => setLocation('start_location', v)} placeholder="Lyon" />
        <Field label="To"   value={d('end_location')}   onChange={v => setLocation('end_location', v)}   placeholder="Valence" />
      </div>
      <Field label="River name (optional)" value={d('river_name')} onChange={v => setLocation('river_name', v)} placeholder="Rhône" />

      <div>
        <button
          type="button"
          onClick={handleGeneratePath}
          disabled={generating || !d('start_location') || !d('end_location')}
          title={!d('start_location') || !d('end_location') ? 'Add start and end first' : undefined}
          style={{ color: 'var(--kind-river_transfer)', border: '1px solid color-mix(in srgb, var(--kind-river_transfer) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-river_transfer) 8%, transparent)' }}
          className="px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity"
        >
          {generating ? 'Generating…' : 'Generate river path'}
        </button>
        {pathMsg && <p className="text-xs mt-1" style={{ color: pathMsg.color }}>{pathMsg.text}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Distance" value={d('distance')} onChange={v => setD('distance', v)} placeholder="45 km" />
        <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="3h 30m" />
      </div>
      <Field label="Per person" value={d('cost_per_person')} onChange={v => setD('cost_per_person', v)} placeholder="€30" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="CONF123" />
        <Field label="Provider"    value={d('provider')}    onChange={v => setD('provider', v)}    placeholder="Rhône Cruises" />
      </div>
      <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+33 ..." />
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Meet at the dock, arrive 20 min early…" />
    </div>
  )
}

function RailForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  // Changing a time recomputes duration live (naive wall-clock — same-region rail).
  const setTimed = (key, val) => setDetails(prev => {
    const next = { ...prev, [key]: val }
    const dur = fmtDurationMin(durationBetween(next.depart_time, next.arrive_time))
    if (dur) next.duration = dur
    return next
  })
  const [showLookup, setShowLookup] = useState(false)
  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Label" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="London → Paris" />
        </div>
        <button
          type="button"
          onClick={() => setShowLookup(true)}
          disabled={!d('train_number') || !d('origin')}
          title={!d('train_number') || !d('origin') ? 'Enter train number and origin station first' : 'Look up live times'}
          style={{ color: 'var(--kind-rail)', border: '1px solid color-mix(in srgb, var(--kind-rail) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-rail) 8%, transparent)' }}
          className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity"
        >
          Look up times
        </button>
      </div>
      {showLookup && (
        <RailLookupModal
          details={details}
          onApply={(key, value) => setD(key, value)}
          onClose={() => setShowLookup(false)}
        />
      )}
      <SectionBox label="Route">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From station" value={d('origin')} onChange={v => setD('origin', v)} placeholder="London St Pancras" />
          <Field label="To station"   value={d('destination')} onChange={v => setD('destination', v)} placeholder="Paris Gare du Nord" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Train number" value={d('train_number')} onChange={v => setD('train_number', v)} placeholder="9057" />
          <Field label="Operator"     value={d('operator')} onChange={v => setD('operator', v)} placeholder="Eurostar" />
        </div>
      </SectionBox>
      <SectionBox label="Schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Departs" type="datetime-local" value={d('depart_time')} onChange={v => setTimed('depart_time', v)} />
          <Field label="Arrives" type="datetime-local" value={d('arrive_time')} onChange={v => setTimed('arrive_time', v)} min={d('depart_time')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dep platform" value={d('depart_platform')} onChange={v => setD('depart_platform', v)} placeholder="Platform 2" />
          <Field label="Arr platform" value={d('arrive_platform')} onChange={v => setD('arrive_platform', v)} placeholder="Voie 8" />
        </div>
        <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="2h 16m" />
      </SectionBox>
      <SectionBox label="Service">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Class" value={d('rail_class')} onChange={v => setD('rail_class', v)} placeholder="Business Premier" />
          <Field label="Coach" value={d('coach')}      onChange={v => setD('coach', v)}      placeholder="Coach 12" />
        </div>
      </SectionBox>
      <PassengerEditor kind="rail" details={details} setDetails={setDetails} />
      <SectionBox label="Booking">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="BKTX42" />
          <Field label="Phone"       value={d('booking_phone')} onChange={v => setD('booking_phone', v)} placeholder="+44 3432 186186" />
        </div>
        <Field label="Booking URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
        <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="…" />
      </SectionBox>
    </div>
  )
}

const SURFACE_TYPES = ['road', 'gravel', 'sand', 'dirt']

function parseMapsUrl(url) {
  try {
    const u = new URL(url)
    const coordRe = /^-?\d+\.?\d*,-?\d+\.?\d*$/
    const toCoord  = raw => { const [lat, lng] = raw.split(',').map(Number); return { lat, lng } }
    const m = u.pathname.match(/\/maps\/dir\/(.+)/)
    if (m) {
      const parts = m[1].split('/').filter(p =>
        p && !p.startsWith('@') && !p.startsWith('data') && !p.includes('=')
      )
      if (parts.length >= 2) {
        const rawStart = parts[0]
        const rawEnd   = parts[parts.length - 1]
        // Collect every coordinate waypoint in path order
        const allCoords = parts.filter(p => coordRe.test(p)).map(toCoord)
        // Full ordered list of stops (start, any intermediate waypoints, end) as text
        const waypoints = parts.map(p => decodeURIComponent(p.replace(/\+/g, ' ')))
        const result = {
          start: decodeURIComponent(rawStart.replace(/\+/g, ' ')),
          end:   decodeURIComponent(rawEnd.replace(/\+/g, ' ')),
          waypoints,
          allCoords,
        }
        if (coordRe.test(rawStart)) result.startCoords = toCoord(rawStart)
        if (coordRe.test(rawEnd))   result.endCoords   = toCoord(rawEnd)
        return result
      }
    }
    const start = u.searchParams.get('origin') || u.searchParams.get('saddr')
    const end   = u.searchParams.get('destination') || u.searchParams.get('daddr')
    if (start || end) return { start: start || '', end: end || '' }
  } catch {}
  return null
}

// Build a Google Maps directions URL through an ordered list of points (start,
// intermediate waypoints, end). `mode` is 'w' (walk), 'd' (drive), 'b' (bike).
// Pass embed=true for the iframe-embeddable variant.
export function buildMapsUrl(points, mode = 'w', embed = false) {
  const pts = (points || []).filter(Boolean)
  if (!pts.length) return null
  const base = 'https://maps.google.com/maps?'
  const suffix = embed ? '&output=embed' : ''
  if (pts.length === 1) return base + new URLSearchParams({ q: pts[0] }).toString() + suffix
  // Keep the literal "to:" keyword Google uses for multi-stop routes.
  const saddr = encodeURIComponent(pts[0])
  const daddr = pts.slice(1).map(encodeURIComponent).join('+to:')
  return `${base}saddr=${saddr}&daddr=${daddr}&dirflg=${mode}${suffix}`
}

function haversineKm(c1, c2) {
  const R = 6371
  const dLat = (c2.lat - c1.lat) * Math.PI / 180
  const dLng = (c2.lng - c1.lng) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(c1.lat * Math.PI / 180) * Math.cos(c2.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Geocode `name` and validate the result is within the route's bounds.
// Tries the address part (after the first comma) before the full name so that
// "Business Name, 24 Street, City" hits the correct address rather than
// matching the business name to a location in the wrong city.
async function geocodeForRoute(name, routeCoords) {
  let span = 0
  for (let i = 0; i < routeCoords.length; i++)
    for (let j = i + 1; j < routeCoords.length; j++)
      span = Math.max(span, haversineKm(routeCoords[i], routeCoords[j]))
  const threshold = routeCoords.length ? Math.max(50, span * 1.5) : Infinity
  const inRange = pt =>
    routeCoords.length === 0 || routeCoords.some(c => haversineKm(pt, c) < threshold)

  const commaIdx = name.indexOf(',')
  const addrPart = commaIdx >= 0 ? name.slice(commaIdx + 1).trim() : ''
  // Try address-first so a business name doesn't match the wrong city; fall back to full name.
  const attempts = addrPart.length >= 5 ? [addrPart, name] : [name]

  for (const q of attempts) {
    try {
      const pt = await fetchGeocode(q)
      if (inRange(pt)) return pt
    } catch {}
  }
  return null
}

function CyclingForm({ itemId, core, details, setCore, setDetails }) {
  const [mapsUrl, setMapsUrl]     = useState('')
  const [mapsMsg, setMapsMsg]     = useState(null)
  const [gpxBusy, setGpxBusy]    = useState(false)
  const [gpxMsg, setGpxMsg]       = useState(null)
  const d   = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  function extractMaps() {
    const res = parseMapsUrl(mapsUrl)
    if (!res) { setMapsMsg({ text: 'Could not parse this URL', color: 'var(--error)' }); return }
    setMapsMsg(null)
    let filled = 0
    if (res.start && !details.start_location) { setD('start_location', res.start); filled++ }
    if (res.end   && !details.end_location)   { setD('end_location',   res.end);   filled++ }
    if (res.waypoints && res.waypoints.length > 2) { setD('route_points', res.waypoints); filled++ }
    setMapsMsg(filled ? { text: `${filled} location${filled > 1 ? 's' : ''} filled`, color: 'var(--success)' }
                      : { text: 'Nothing to add (fields already filled)', color: 'var(--text-faint)' })
  }

  async function handleGpx(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setGpxBusy(true); setGpxMsg(null)
    try {
      const updated = await uploadGpx(itemId, file)
      setDetails(updated.details ?? {})
      setGpxMsg({ text: `✓ ${file.name} uploaded`, color: 'var(--success)' })
    } catch (err) {
      setGpxMsg({ text: err.message, color: 'var(--error)' })
    } finally {
      setGpxBusy(false)
      e.target.value = ''
    }
  }

  async function handleGenGpx() {
    const points = routePointsOf(details)
    if (points.length < 2) {
      setGpxMsg({ text: 'Add a route first (paste a Google Maps directions URL above)', color: 'var(--error)' })
      return
    }
    setGpxBusy(true); setGpxMsg(null)
    try {
      const updated = await routeToGpx(itemId, points, 'cycling')
      setDetails(updated.details ?? {})
      setGpxMsg({ text: '✓ GPX generated from route', color: 'var(--success)' })
    } catch (err) {
      setGpxMsg({ text: err.message, color: 'var(--error)' })
    } finally {
      setGpxBusy(false)
    }
  }

  const surface = d('surface_type')

  return (
    <div className="space-y-4">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Morning gravel ride" />
      <Field label="Start time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />

      <SectionBox label="Import from Google Maps">
        <div className="flex gap-2">
          <input
            value={mapsUrl}
            onChange={e => setMapsUrl(e.target.value)}
            placeholder="Paste directions URL…"
            style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
          <button type="button" onClick={extractMaps}
            style={{ color: 'var(--kind-cycling)', border: '1px solid color-mix(in srgb, var(--kind-cycling) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-cycling) 8%, transparent)' }}
            className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity">
            Extract
          </button>
        </div>
        {mapsMsg && <p className="text-xs mt-1" style={{ color: mapsMsg.color }}>{mapsMsg.text}</p>}
      </SectionBox>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Start" value={d('start_location')} onChange={v => setD('start_location', v)} placeholder="Trailhead / town" />
        <Field label="End"   value={d('end_location')}   onChange={v => setD('end_location',   v)} placeholder="Finish / summit" />
      </div>

      <div className="flex flex-col gap-1.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Surface</label>
        <div className="flex gap-2 flex-wrap">
          {SURFACE_TYPES.map(s => (
            <button key={s} type="button" onClick={() => setD('surface_type', surface === s ? '' : s)}
              style={{
                color: surface === s ? 'var(--kind-cycling)' : 'var(--text-faint)',
                border: `1px solid ${surface === s ? 'var(--kind-cycling)' : 'var(--border)'}`,
                background: surface === s ? 'color-mix(in srgb, var(--kind-cycling) 12%, transparent)' : 'transparent',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors">
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Distance"   value={d('distance')}       onChange={v => setD('distance', v)}       placeholder="42 km" />
        <Field label="Elev ↑"     value={d('elevation_gain')} onChange={v => setD('elevation_gain', v)} placeholder="800 m" />
        <Field label="Elev ↓"     value={d('elevation_loss')} onChange={v => setD('elevation_loss', v)} placeholder="650 m" />
      </div>
      <DistanceButton points={routePointsOf(details)} mode="cycling" color="var(--kind-cycling)"
        onResult={r => {
          if (r.distance_text) setD('distance', r.distance_text)
          if (r.elevation_gain_text) setD('elevation_gain', r.elevation_gain_text)
          if (r.elevation_loss_text) setD('elevation_loss', r.elevation_loss_text)
        }} />

      <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Conditions, kit…" />

      <div className="flex flex-col gap-1.5">
        <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">GPX File</label>
        <div className="flex items-center gap-3 flex-wrap">
          <label style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', cursor: gpxBusy ? 'default' : 'pointer', opacity: gpxBusy ? 0.5 : 1 }}
            className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity">
            {gpxBusy ? 'Uploading…' : d('gpx_filename') ? 'Replace GPX' : 'Upload GPX'}
            <input type="file" accept=".gpx,application/gpx+xml" onChange={handleGpx} disabled={gpxBusy} className="hidden" />
          </label>
          <button type="button" onClick={handleGenGpx} disabled={gpxBusy}
            style={{ color: 'var(--kind-cycling)', border: '1px solid color-mix(in srgb, var(--kind-cycling) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-cycling) 8%, transparent)', opacity: gpxBusy ? 0.5 : 1 }}
            className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity">
            Generate from route
          </button>
          {gpxMsg && <span className="text-xs" style={{ color: gpxMsg.color }}>{gpxMsg.text}</span>}
          {!gpxMsg && d('original_gpx_name') && (
            <span className="text-xs" style={{ color: 'var(--text-faint)' }}>{d('original_gpx_name')}</span>
          )}
        </div>
        {d('gpx_filename') && !gpxMsg && (
          <p style={{ color: 'var(--text-faint)' }} className="text-xs">
            Stats auto-extracted — edit above if needed
          </p>
        )}
      </div>
    </div>
  )
}

function PurchaseForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  return (
    <div className="space-y-4">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Silk scarf" />
      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="What it is, why you want it…" rows={3} />
      <Field label="Shop / Location" value={d('location')} onChange={v => setD('location', v)} placeholder="Night market, Chatuchak…" />
      <Field label="Link / URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="…" />
    </div>
  )
}

function FoodForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  return (
    <div className="space-y-4">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Pasta alla Norma" />
      <TextArea label="Description" value={d('description')} onChange={v => setD('description', v)} placeholder="Notes, what to order, what to avoid…" rows={3} />
      <Field label="Link (optional)" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="…" />
    </div>
  )
}

export default function ItemEditModal({ item, onSave, onClose, onDeleted, isNew = false, stops: stopsProp }) {
  // Block data-sync refreshes while this modal is open
  useEffect(() => { setEditing(true); return () => setEditing(false) }, [])

  const [core, setCore] = useState({
    kind: item.kind ?? 'activity',
    name: item.name ?? '',
    cost: item.cost ?? '',
    link: item.link ?? '',
    notes: item.notes ?? '',
    scheduled_at: item.scheduled_at ? item.scheduled_at.slice(0, 16) : null,
  })
  const [details, setDetails] = useState(item.details ?? {})
  const [saving, setSaving] = useState(false)
  const [savingMsg, setSavingMsg] = useState('')
  const [error, setError] = useState(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [stops, setStops] = useState([])
  const [targetStop, setTargetStop] = useState(item.stop_id ?? (stopsProp?.[0]?.id ?? null))

  // Snapshot the initial form state once, so any close attempt (backdrop
  // click, ✕, Cancel) can warn before silently discarding real edits.
  const initialSnapshot = useRef(JSON.stringify({ core, details, targetStop }))
  function requestClose() {
    const dirty = JSON.stringify({ core, details, targetStop }) !== initialSnapshot.current
    if (dirty && !confirm('Discard unsaved changes?')) return
    onClose()
  }

  useEffect(() => {
    if (!isNew && item.id) getItemStops(item.id).then(setStops).catch(() => {})
  }, [item.id, isNew])

  async function handleDelete() {
    if (deleting) return
    setDeleting(true); setError(null)
    try {
      await deleteItem(item.id)
      onDeleted?.(item.id)
      onClose()
    } catch (e) {
      setError(e.message); setDeleting(false)
    }
  }

  async function save() {
    if (saving) return
    // Block an end before its start (check-out < check-in, arrival < departure).
    const pair =
      core.kind === 'accommodation' ? [details.checkin, details.checkout, 'Check-out cannot be before check-in']
      : (core.kind === 'flight' || core.kind === 'rail') ? [details.depart_time, details.arrive_time, 'Arrival cannot be before departure']
      : null
    if (pair && pair[0] && pair[1] && toLocalInput(pair[1]) < toLocalInput(pair[0])) {
      setError(pair[2]); return
    }
    setSaving(true); setSavingMsg(''); setError(null)
    try {
      let finalDetails = { ...details }

      // Auto-fill duration from depart/arrive times when the user left it blank.
      // Rail: same-region surface travel — naive wall-clock difference. Flight:
      // only when both timezone fields are set, since a naive diff across zones is
      // wrong and there's no easy in-app TZ lookup.
      if (!finalDetails.duration && finalDetails.depart_time && finalDetails.arrive_time) {
        if (core.kind === 'rail') {
          const dur = fmtDurationMin(durationBetween(finalDetails.depart_time, finalDetails.arrive_time))
          if (dur) finalDetails.duration = dur
        } else if (core.kind === 'flight'
          && parseTzOffsetMin(finalDetails.depart_tz) != null
          && parseTzOffsetMin(finalDetails.arrive_tz) != null) {
          const dur = fmtDurationMin(durationBetween(
            finalDetails.depart_time, finalDetails.arrive_time,
            finalDetails.depart_tz, finalDetails.arrive_tz))
          if (dur) finalDetails.duration = dur
        }
      }

      const homeCurrency = getHomeCurrency()
      const costChanged = core.cost !== (item.cost ?? '')
      const paidChanged = (details.amount_paid ?? '') !== (item.details?.amount_paid ?? '')

      if (!core.cost) {
        // Cost removed — clear all conversion data
        const { converted_cost: _a, converted_amount_paid: _b, converted_currency: _c, ...rest } = finalDetails
        finalDetails = rest
      } else if (homeCurrency) {
        const parsed = parseCost(core.cost)
        if (parsed && parsed.code !== homeCurrency) {
          // Re-convert if cost changed or if no conversion stored yet
          if (costChanged || finalDetails.converted_cost == null) {
            setSavingMsg(`Converting ${parsed.code} → ${homeCurrency}…`)
            const converted = await convertCurrency(parsed.amount, parsed.code, homeCurrency)
            finalDetails = { ...finalDetails, converted_cost: converted, converted_currency: homeCurrency }
          }
          // Re-convert amount_paid if it changed or no conversion stored yet
          if ((costChanged || paidChanged || finalDetails.converted_amount_paid == null) && finalDetails.amount_paid != null) {
            const parsedPaid = parseCost(finalDetails.amount_paid)
            const paidAmount = parsedPaid != null ? parsedPaid.amount : parseFloat(finalDetails.amount_paid)
            if (paidAmount === 0) {
              finalDetails = { ...finalDetails, converted_amount_paid: 0 }
            } else if (paidAmount > 0) {
              const convertedPaid = await convertCurrency(paidAmount, parsed.code, homeCurrency)
              finalDetails = { ...finalDetails, converted_amount_paid: convertedPaid }
            }
          } else if (!finalDetails.amount_paid) {
            const { converted_amount_paid: _, ...rest } = finalDetails
            finalDetails = rest
          }
        } else if (parsed && parsed.code === homeCurrency) {
          // Same currency — no conversion needed, clear stale data
          const { converted_cost: _a, converted_amount_paid: _b, converted_currency: _c, ...rest } = finalDetails
          finalDetails = rest
        }
      }

      let updated
      if (isNew) {
        const stopId = targetStop ?? item.stop_id
        if (!stopId) { setError('Choose a stop first'); setSaving(false); return }
        updated = await createItem(stopId, { ...core, scheduled_at: core.scheduled_at || null, details: finalDetails })
      } else {
        updated = await updateItem(item.id, { ...core, scheduled_at: core.scheduled_at || null, details: finalDetails })
        if (targetStop && targetStop !== item.stop_id) {
          setSavingMsg('Moving…')
          updated = await moveItem(item.id, targetStop)
        }
      }
      onSave(updated)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const color = KIND_VAR[core.kind] ?? 'var(--text-muted)'

  // Warn if the item's date span sits outside the (selected) stop's window.
  // Most items are a single point; some legitimately straddle a stop boundary:
  // accommodations span check-in → check-out (a hotel booked the night before arrival
  // or checking out on departure day still overlaps its stop), and transit spans
  // departure → arrival (an overnight train arriving in the morning left the previous
  // city the evening before). A span that overlaps the window at all isn't flagged.
  // An accommodation with no check-out is open-ended (a lone check-in is an ongoing
  // stay, not zero nights), so it is never flagged as ending before arrival. A
  // check-out earlier than the check-in is contradictory data and is treated the
  // same way, so it never makes a stay look like it ended before the stop began.
  const stopForCheck = stops.find(s => s.id === targetStop)
  const isTransit = core.kind === 'flight' || core.kind === 'rail' || core.kind === 'transfer' || core.kind === 'river_transfer'
  const spanStart =
    (core.kind === 'flight' || core.kind === 'rail' || core.kind === 'river_transfer') ? details.depart_time
    : core.kind === 'accommodation' ? (details.checkin || core.scheduled_at)
    : core.scheduled_at
  const accomCheckout =
    details.checkout && (!spanStart || String(details.checkout) >= String(spanStart))
      ? details.checkout : null
  const spanEnd =
    core.kind === 'accommodation' ? accomCheckout
    : isTransit ? (details.arrive_time || spanStart)
    : spanStart
  // Final stop is exempt from "after departure" (the journey home departs after it).
  const lastStopId = stops.reduce((best, s) => {
    const k = s.depart || s.arrive
    if (!k) return best
    const bk = best ? (best.depart || best.arrive) : null
    return (!bk || String(k) > String(bk)) ? s : best
  }, null)?.id
  const dateWarning = (() => {
    if (!stopForCheck || !spanStart) return null
    const startDay = String(spanStart).slice(0, 10)
    const endDay = spanEnd ? String(spanEnd).slice(0, 10) : null
    const a = stopForCheck.arrive ? String(stopForCheck.arrive).slice(0, 10) : null
    const d = stopForCheck.depart ? String(stopForCheck.depart).slice(0, 10) : null
    if (a && endDay && endDay < a) return `Date is before this stop begins (${fmtDay(stopForCheck.arrive)})`
    if (d && startDay > d && stopForCheck.id !== lastStopId) return `Date is after this stop ends (${fmtDay(stopForCheck.depart)})`
    return null
  })()

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && requestClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', maxHeight: '90vh' }}
        className="w-full max-w-lg rounded-2xl flex flex-col overflow-hidden"
      >
        {/* Stop picker — shown when creating from the global add button */}
        {isNew && stopsProp && stopsProp.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }} className="px-5 py-2 flex items-center gap-2">
            <span style={{ color: 'var(--text-faint)' }} className="text-xs shrink-0">Add to</span>
            <select
              value={targetStop ?? ''}
              onChange={e => setTargetStop(Number(e.target.value))}
              style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
              className="flex-1 rounded-lg px-2 py-1 text-xs outline-none focus:border-[var(--accent)]"
            >
              {stopsProp.map(s => (
                <option key={s.id} value={s.id} style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>
                  {s.location}{s.arrive ? ` · ${fmtDay(s.arrive)}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

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
            {KIND_OPTIONS.map(k => (
              <option key={k} value={k} style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <span style={{ color: 'var(--text)' }} className="flex-1 text-sm font-medium truncate">{core.name || item.name}</span>
          <button
            onClick={requestClose}
            style={{ color: 'var(--text-faint)' }}
            className="hover:opacity-70 transition-opacity text-lg leading-none shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {dateWarning && (
            <div
              style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', color: 'var(--text)' }}
              className="mb-4 rounded-lg px-3 py-2 text-xs flex items-center gap-2"
            >
              <span style={{ color: 'var(--warning)' }}>⚠</span>
              <span>{dateWarning}</span>
            </div>
          )}
          {core.kind === 'accommodation' ? (
            <AccommodationForm itemId={item.id} stopId={targetStop ?? item.stop_id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'restaurant' ? (
            <RestaurantForm itemId={item.id} stopId={targetStop ?? item.stop_id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'show' ? (
            <ShowForm itemId={item.id} stopId={targetStop ?? item.stop_id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'activity' ? (
            <ActivityForm itemId={item.id} stopId={targetStop ?? item.stop_id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'walk' ? (
            <WalkForm itemId={item.id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'transfer' ? (
            <TransferForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'river_transfer' ? (
            <RiverTransferForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'tour' ? (
            <TourForm itemId={item.id} stopId={targetStop ?? item.stop_id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'cycling' ? (
            <CyclingForm itemId={item.id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'rail' ? (
            <RailForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'flight' ? (
            <FlightForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'purchase' ? (
            <PurchaseForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'food' ? (
            <FoodForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'hire' ? (
            <HireForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : (
            <GenericForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          )}
          <div style={{ borderTop: '1px solid var(--border)' }} className="mt-4 pt-4">
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">Payment</p>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Total cost"
                value={core.cost ?? ''}
                onChange={v => setCore(c => ({ ...c, cost: v || '' }))}
              />
              <Field
                label="Amount paid"
                value={details.amount_paid ?? ''}
                onChange={v => setDetails(d => ({ ...d, amount_paid: v || undefined }))}
              />
            </div>
          </div>
          {!isNew && stops.length > 1 && (
            <div style={{ borderTop: '1px solid var(--border)' }} className="mt-4 pt-4">
              <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">Move to stop</p>
              <select
                value={targetStop ?? ''}
                onChange={e => setTargetStop(Number(e.target.value))}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              >
                {stops.map(s => (
                  <option key={s.id} value={s.id} style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>
                    {s.location}{s.arrive ? ` · ${fmtDay(s.arrive)}` : ''}{s.id === item.stop_id ? ' (current)' : ''}
                  </option>
                ))}
              </select>
              {targetStop !== item.stop_id && (
                <p style={{ color: 'var(--text-faint)' }} className="text-xs mt-1">Saved on Save.</p>
              )}
            </div>
          )}
          {error && <p style={{ color: 'var(--error)' }} className="text-xs mt-3">{error}</p>}
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} className="flex items-center gap-3 px-5 py-4">
          {!isNew && confirmingDelete ? (
            <>
              <span style={{ color: 'var(--text)' }} className="text-sm flex-1">Delete this item?</span>
              <button
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
                style={{ color: 'var(--text-faint)' }}
                className="text-sm hover:opacity-70 transition-opacity"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{ background: 'var(--error)', color: '#fff' }}
                className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              {!isNew && onDeleted && (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  style={{ color: 'var(--error)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)' }}
                  className="px-3 py-2 rounded-lg text-sm font-medium hover:opacity-80 transition-opacity"
                >
                  Delete
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={requestClose}
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
                {savingMsg || (saving ? 'Saving…' : 'Save')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
