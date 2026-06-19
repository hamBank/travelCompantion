import { useState } from 'react'
import { updateItem, enrichItem, uploadGpx, lookupAirline, fetchRouteElevation, fetchGeocode } from '../api.js'

const KIND_VAR = {
  activity:      'var(--kind-activity)',
  restaurant:    'var(--kind-restaurant)',
  note:          'var(--kind-note)',
  accommodation: 'var(--kind-accommodation)',
  flight:        'var(--kind-flight)',
  cycling:       'var(--kind-cycling)',
  rail:          'var(--kind-rail)',
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

function AutoFillButton({ enriching, enrichMsg, onClick }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={enriching}
        style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
        className="shrink-0 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity"
        title="Auto-fill empty fields from Google Places"
      >
        {enriching ? '…' : 'Auto-fill'}
      </button>
      {enrichMsg && (
        <span className="text-xs" style={{ color: enrichMsg.color }}>{enrichMsg.text}</span>
      )}
    </div>
  )
}

function AccommodationForm({ itemId, core, details, setCore, setDetails }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  async function autoFill() {
    if (enriching) return
    setEnriching(true)
    setEnrichMsg(null)
    try {
      const suggestions = await enrichItem(itemId)
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
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} />
      </div>
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

const BOOKING_STATUS = ['planned', 'booked', 'confirmed']

function RestaurantForm({ itemId, core, details, setCore, setDetails }) {
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
    if (enriching) return
    setEnriching(true)
    setEnrichMsg(null)
    try {
      const suggestions = await enrichItem(itemId)
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
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} />
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cost" value={core.cost} onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="€60" />
        <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Dietary needs…" />
      </div>
    </div>
  )
}

function FlightForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
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
          <Field label="Departs" type="datetime-local" value={d('depart_time')} onChange={v => setD('depart_time', v)} />
          <Field label="Arrives" type="datetime-local" value={d('arrive_time')} onChange={v => setD('arrive_time', v)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dep terminal" value={d('origin_terminal')} onChange={v => setD('origin_terminal', v)} placeholder="T1" />
          <Field label="Arr terminal" value={d('arrive_terminal')} onChange={v => setD('arrive_terminal', v)} placeholder="T2" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dep gate" value={d('origin_gate')} onChange={v => setD('origin_gate', v)} placeholder="D12" />
          <Field label="Arr gate" value={d('arrive_gate')} onChange={v => setD('arrive_gate', v)} placeholder="23" />
        </div>
        <Field label="Check-in desk" value={d('checkin_desk')} onChange={v => setD('checkin_desk', v)} placeholder="D5–D20" />
        <div className="grid grid-cols-2 gap-3">
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

function ActivityForm({ itemId, core, details, setCore, setDetails }) {
  const [enriching, setEnriching] = useState(false)
  const [enrichMsg, setEnrichMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))

  async function autoFill() {
    if (enriching) return
    setEnriching(true)
    setEnrichMsg(null)
    try {
      const suggestions = await enrichItem(itemId)
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
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Activity name" />
        </div>
        <AutoFillButton enriching={enriching} enrichMsg={enrichMsg} onClick={autoFill} />
      </div>
      <Field label="Date & time" type="datetime-local" value={core.scheduled_at ?? ''} onChange={v => setCore(c => ({ ...c, scheduled_at: v || null }))} />
      <Field label="Address" value={d('location')} onChange={v => setD('location', v)} placeholder="123 Main St, City" />
      <Field label="Phone" value={d('contact_phone')} onChange={v => setD('contact_phone', v)} placeholder="+1 234 567 8900" />
      <Field label="Website" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Notes…" />
      <Field label="Cost" value={core.cost} onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="€20" />
    </div>
  )
}

function GenericForm({ core, setCore }) {
  return (
    <div className="space-y-3">
      <Field label="Name" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="Note title" />
      <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Notes…" />
      <Field label="Link" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
      <Field label="Cost" value={core.cost} onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="€20" />
    </div>
  )
}

const DIFFICULTY = ['easy', 'moderate', 'hard', 'strenuous']

function WalkForm({ core, details, setCore, setDetails }) {
  const [mapsUrl, setMapsUrl] = useState('')
  const [mapsMsg, setMapsMsg] = useState(null)
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  const diff = d('difficulty')

  async function extractMaps() {
    const res = parseMapsUrl(mapsUrl)
    if (!res) { setMapsMsg({ text: 'Could not parse this URL', color: 'var(--error)' }); return }
    setMapsMsg({ text: 'Extracting…', color: 'var(--text-faint)' })
    let filled = 0
    if (res.start && !details.start_location) { setD('start_location', res.start); filled++ }
    if (res.end   && !details.end_location)   { setD('end_location',   res.end);   filled++ }
    if (mapsUrl) { setD('maps_url', mapsUrl) }

    // If no coords at all in the URL, try geocoding the place names
    if (!res.startCoords && res.start) {
      try { res.startCoords = await fetchGeocode(res.start) } catch (e) {
        setMapsMsg({ text: `Geocode failed: ${e.message}`, color: 'var(--warning)' })
      }
    }
    if (!res.endCoords && res.end) {
      try { res.endCoords = await fetchGeocode(res.end) } catch (e) {
        setMapsMsg({ text: `Geocode failed: ${e.message}`, color: 'var(--warning)' })
      }
    }

    if (!details.distance && res.allCoords?.length >= 2) {
      // Sum haversine along all route waypoints for a better estimate than start→end straight-line
      const km = res.allCoords.reduce((sum, c, i) =>
        i === 0 ? 0 : sum + haversineKm(res.allCoords[i - 1], c), 0)
      setD('distance', `~${km.toFixed(1)} km`)
      filled++
    } else if (!details.distance && res.startCoords && res.endCoords) {
      const km = haversineKm(res.startCoords, res.endCoords)
      setD('distance', `~${km.toFixed(1)} km`)
      filled++
    }

    if (res.startCoords && res.endCoords && !details.elevation_gain && !details.elevation_loss) {
      try {
        const elev = await fetchRouteElevation(
          res.startCoords.lat, res.startCoords.lng,
          res.endCoords.lat, res.endCoords.lng,
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="Duration"  value={d('duration')} onChange={v => setD('duration', v)} placeholder="3h 30m" />
        <Field label="Cost"      value={core.cost}     onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="€0" />
      </div>
      <TextArea label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Trail conditions, gear needed…" />
    </div>
  )
}

export const KIND_LABEL = {
  activity: 'Activity', walk: 'Walk / Hike', cycling: 'Cycling', rail: 'Rail',
  restaurant: 'Restaurant', note: 'Note',
  accommodation: 'Accommodation', flight: 'Flight',
}

function RailForm({ core, details, setCore, setDetails }) {
  const d = key => details[key] ?? ''
  const setD = (key, val) => setDetails(prev => ({ ...prev, [key]: val }))
  return (
    <div className="space-y-4">
      <Field label="Label" value={core.name} onChange={v => setCore(c => ({ ...c, name: v }))} placeholder="London → Paris" />
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
          <Field label="Departs" type="datetime-local" value={d('depart_time')} onChange={v => setD('depart_time', v)} />
          <Field label="Arrives" type="datetime-local" value={d('arrive_time')} onChange={v => setD('arrive_time', v)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Dep platform" value={d('depart_platform')} onChange={v => setD('depart_platform', v)} placeholder="Platform 2" />
          <Field label="Arr platform" value={d('arrive_platform')} onChange={v => setD('arrive_platform', v)} placeholder="Voie 8" />
        </div>
        <Field label="Duration" value={d('duration')} onChange={v => setD('duration', v)} placeholder="2h 16m" />
      </SectionBox>
      <SectionBox label="Service">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Class"  value={d('rail_class')} onChange={v => setD('rail_class', v)} placeholder="Business Premier" />
          <Field label="Coach"  value={d('coach')}      onChange={v => setD('coach', v)}      placeholder="Coach 12" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Seats"  value={d('seats')}      onChange={v => setD('seats', v)}      placeholder="12A, 12B" />
          <Field label="Meal"   value={d('meal')}       onChange={v => setD('meal', v)}       placeholder="Yes" />
        </div>
      </SectionBox>
      <SectionBox label="Passengers">
        <TextArea label="Names"           value={d('passengers')}  onChange={v => setD('passengers', v)}  placeholder="Antony Wuth, Nicole Wuth" />
        <TextArea label="Loyalty numbers" value={d('loyalty_info')} onChange={v => setD('loyalty_info', v)} placeholder="Eurostar Plus points…" />
      </SectionBox>
      <SectionBox label="Booking">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Booking ref" value={d('booking_ref')} onChange={v => setD('booking_ref', v)} placeholder="BKTX42" />
          <Field label="Phone"       value={d('booking_phone')} onChange={v => setD('booking_phone', v)} placeholder="+44 3432 186186" />
        </div>
        <Field label="Booking URL" value={core.link} onChange={v => setCore(c => ({ ...c, link: v }))} placeholder="https://…" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Total cost"  value={core.cost} onChange={v => setCore(c => ({ ...c, cost: v }))} placeholder="€250" />
          <Field label="Notes"       value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="…" />
        </div>
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
      const parts = m[1].split('/').filter(p => p && !p.startsWith('@') && !p.startsWith('data'))
      if (parts.length >= 2) {
        const rawStart = parts[0]
        const rawEnd   = parts[parts.length - 1]
        // Collect every coordinate waypoint in path order (may include start/end and intermediates)
        const allCoords = parts.filter(p => coordRe.test(p)).map(toCoord)
        const result = {
          start: decodeURIComponent(rawStart.replace(/\+/g, ' ')),
          end:   decodeURIComponent(rawEnd.replace(/\+/g, ' ')),
          allCoords,
        }
        if (coordRe.test(rawStart)) result.startCoords = toCoord(rawStart)
        if (coordRe.test(rawEnd))   result.endCoords   = toCoord(rawEnd)
        // Named start/end: use nearest available coord waypoint as fallback
        if (!result.startCoords && allCoords.length > 0) result.startCoords = allCoords[0]
        if (!result.endCoords   && allCoords.length > 0) result.endCoords   = allCoords[allCoords.length - 1]
        return result
      }
    }
    const start = u.searchParams.get('origin') || u.searchParams.get('saddr')
    const end   = u.searchParams.get('destination') || u.searchParams.get('daddr')
    if (start || end) return { start: start || '', end: end || '' }
  } catch {}
  return null
}

function haversineKm(c1, c2) {
  const R = 6371
  const dLat = (c2.lat - c1.lat) * Math.PI / 180
  const dLng = (c2.lng - c1.lng) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(c1.lat * Math.PI / 180) * Math.cos(c2.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
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

      <div className="grid grid-cols-2 gap-3">
        <Field label="Cost"  value={core.cost}  onChange={v => setCore(c => ({ ...c, cost: v }))}  placeholder="€0" />
        <Field label="Notes" value={core.notes} onChange={v => setCore(c => ({ ...c, notes: v }))} placeholder="Conditions, kit…" />
      </div>

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
          <p style={{ color: 'var(--text-faint)' }} className="text-xs">
            Stats auto-extracted — edit above if needed
          </p>
        )}
      </div>
    </div>
  )
}

export default function ItemEditModal({ item, onSave, onClose }) {
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
  const [error, setError] = useState(null)

  async function save() {
    if (saving) return
    setSaving(true); setError(null)
    try {
      const updated = await updateItem(item.id, { ...core, scheduled_at: core.scheduled_at || null, details })
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
            <AccommodationForm itemId={item.id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'restaurant' ? (
            <RestaurantForm itemId={item.id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'activity' ? (
            <ActivityForm itemId={item.id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'walk' ? (
            <WalkForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'cycling' ? (
            <CyclingForm itemId={item.id} core={core} details={details} setCore={setCore} setDetails={setDetails} />
          ) : core.kind === 'rail' ? (
            <RailForm core={core} details={details} setCore={setCore} setDetails={setDetails} />
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
