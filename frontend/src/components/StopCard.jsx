import { useState, useEffect, createContext, useContext } from 'react'
import { updateStopStatus, updateItemStatus, getWeather, fetchRiverMapBlob, fetchGpxMapBlob, fetchDayMapBlob } from '../api.js'
import { useHideCompleted, useShowInbound, useKindFilter } from '../settings.js'
import { parseCheckinWindow, calcCheckinTime } from '../checkin.js'
import { fmtDay, fmtDayTime, fmtDayHeader } from '../dates.js'
import WeatherDetailModal from './WeatherDetailModal.jsx'
import { useCanEdit, useCanQueueEdit } from '../roles.js'
import { KindIcon } from '../kindIcons.jsx'
import { Check, Pencil, Wind, BedDouble } from 'lucide-react'
import { offlineQueue } from '../offlineQueue.js'
import ItemRow from './ItemRow.jsx'
import FlightDetailModal from './FlightDetailModal.jsx'
import ItemDetailModal from './ItemDetailModal.jsx'
import ItemEditModal, { buildMapsUrl } from './ItemEditModal.jsx'
import ExpenseQuickAdd from './ExpenseQuickAdd.jsx'
import CostDisplay from './CostDisplay.jsx'
import RichText from './RichText.jsx'
import { isFullyPaid } from '../currency.js'
import { countryFlag, countryCode } from '../countryFlag.js'
import { countryFacts } from '../countryFacts.js'
import { airportName } from '../airportNames.js'
import { KIND_ICON } from '../kinds.js'
import RailDetailModal from './RailDetailModal.jsx'

const STATUS_CYCLE = { planned: 'confirmed', confirmed: 'completed', completed: 'planned', cancelled: 'planned' }

const fmtDate = fmtDay
const fmtDateTime = fmtDayTime

// Offset (minutes) of an IANA zone at a given instant — DST-correct. null if the
// zone name is unknown to the runtime.
function ianaOffsetMin(localAsUtcMs, zone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const parts = {}
    for (const p of dtf.formatToParts(new Date(localAsUtcMs))) parts[p.type] = p.value
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
    return Math.round((asUtc - localAsUtcMs) / 60000)
  } catch {
    return null
  }
}

// Convert a stored local datetime + timezone to UTC milliseconds.
// Accepts "GMT+8"/"UTC-5"/"+08:00" offsets AND IANA names ("Europe/Helsinki").
// Falls back to treating the datetime as UTC when the zone can't be resolved.
export function toUtcMs(dt, tz) {
  if (!dt) return null
  const base = String(dt).includes('T') ? dt : dt + 'T00:00'
  const localAsUtc = new Date(base + 'Z').getTime()
  if (!tz) return localAsUtc
  const m = String(tz).trim().replace(/^(GMT|UTC)/i, '').match(/^\s*([+-]?)(\d{1,2})(?::?(\d{2}))?\s*$/)
  if (m && m[2] !== undefined && (m[1] || m[3] !== undefined || /\d/.test(m[2]))) {
    const sign = m[1] === '-' ? -1 : 1
    const offMin = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10))
    return localAsUtc - offMin * 60000
  }
  // Not an offset — try an IANA zone name.
  const offMin = ianaOffsetMin(localAsUtc, String(tz).trim())
  if (offMin !== null) return localAsUtc - offMin * 60000
  return localAsUtc
}

export function itemDateKey(item) {
  let dt
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer') dt = item.details?.depart_time
  else if (item.kind === 'accommodation') dt = item.details?.checkin || item.scheduled_at
  else dt = item.scheduled_at
  if (!dt) return null
  return String(dt).split('T')[0]
}

// Is a venue closed on the given "YYYY-MM-DD" date, per its stored 7-element
// Monday-first opening_hours (see backend's enrich endpoint normalization)?
// Deliberately conservative: any missing/malformed input returns false — a
// warning chip should only ever appear when we're confident, never as a
// false positive against a venue that's actually open.
export function closedOnDay(openingHours, dateStr) {
  if (!Array.isArray(openingHours) || openingHours.length !== 7) return false
  if (typeof dateStr !== 'string') return false
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return false
  const d = new Date(`${dateStr.slice(0, 10)}T12:00:00`)
  if (isNaN(d)) return false
  // JS getDay(): 0=Sunday..6=Saturday → Monday-first index (Monday=0..Sunday=6).
  const idx = (d.getDay() + 6) % 7
  const entry = openingHours[idx]
  if (typeof entry !== 'string') return false
  return entry.toLowerCase().includes('closed')
}

// Epoch ms when the item is definitively over, or null if undatable. Used by
// the past-items catch-up banner (TripTimeline.jsx) — a several-hour grace
// period there absorbs the approximation from ignoring timezone (naive-local,
// same convention as itemSortKey).
export function itemEndMs(item) {
  const d = item.details || {}
  let dt
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer') dt = d.arrive_time || d.depart_time
  else if (item.kind === 'accommodation') dt = d.checkout || d.checkin
  else dt = item.scheduled_at
  if (!dt) return null
  const ms = toUtcMs(dt, null)
  if (ms == null) return null
  // Date-only values (no time-of-day, or an explicit midnight) — treat as
  // ending at end-of-day so a dated-but-untimed activity isn't "past"
  // during the rest of its own day.
  const timePart = String(dt).split('T')[1]
  const dateOnly = !timePart || timePart.slice(0, 5) === '00:00'
  return dateOnly ? ms + 24 * 3600_000 : ms
}

// An item must have ended this many hours ago before it's flagged as
// "past pending" — absorbs timezone slop and avoids flagging something
// that only just finished. Shared by the catch-up banner (TripTimeline.jsx)
// and the per-card highlight below, so the two can't drift out of sync.
export const PAST_PENDING_GRACE_HOURS = 6

export function isPastPending(item) {
  const end = itemEndMs(item)
  return item.status === 'pending' && end != null && end < Date.now() - PAST_PENDING_GRACE_HOURS * 3600_000
}

// Should a "done" item be hidden by the "hide completed items" display
// preference? A hotel stay is a special case: marking it done (e.g. right
// after checking in, to clear it off a checklist) shouldn't hide it from the
// itinerary while the stay is still ongoing — there's nothing to gain by
// hiding a hotel you're currently staying at, and every other kind of item
// really is over once it's marked done, so they hide immediately.
export function isHiddenWhenCompleted(item, hideCompleted) {
  if (item.status !== 'done' || !hideCompleted) return false
  if (item.kind === 'accommodation') {
    const end = itemEndMs(item)
    return end != null && end <= Date.now()
  }
  return true
}

// Does this item occur on the given local date ("YYYY-MM-DD")? Used by the
// Today view (App.jsx / TripTimeline.jsx) to show only what's relevant right
// now, across every stop.
export function itemOccursOn(item, dateKey) {
  const d = item.details || {}
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer') {
    const depDate = d.depart_time ? String(d.depart_time).split('T')[0] : null
    const arrDate = d.arrive_time ? String(d.arrive_time).split('T')[0] : null
    // A redeye departing yesterday but arriving today still counts as today.
    return depDate === dateKey || arrDate === dateKey
  }
  if (item.kind === 'accommodation') {
    if (!d.checkin) return false
    const checkinDate = String(d.checkin).split('T')[0]
    const checkoutDate = d.checkout ? String(d.checkout).split('T')[0] : checkinDate
    // ISO date strings order lexicographically, so plain string comparison works.
    return checkinDate <= dateKey && dateKey <= checkoutDate
  }
  if (!item.scheduled_at) {
    // Dateless items are excluded, except pinned important notes.
    return item.kind === 'note' && !!d.important
  }
  return String(item.scheduled_at).split('T')[0] === dateKey
}

export function itemTimeStr(item) {
  let dt
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer') dt = item.details?.depart_time
  else if (item.kind === 'accommodation') dt = item.details?.checkin || item.scheduled_at
  else dt = item.scheduled_at
  if (!dt || !String(dt).includes('T')) return ''
  const d = new Date(dt)
  if (isNaN(d)) return ''
  const h = d.getHours(), m = d.getMinutes()
  if (h === 0 && m === 0) return ''
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
}

function itemTz(item) {
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer') return item.details?.depart_tz || ''
  return ''
}

// weatherSource: {lat, lng, query} for whichever location resolved this
// day's weather (the stop's own, or a per-night segment override — see
// weatherSourceFor) — needed so a click-through can re-fetch hourly detail
// for the exact place the summary itself came from.
export function DayBanner({ dateKey, weather, weatherSource }) {
  // Hourly detail only exists for real forecasts (see backend/weather.py's
  // hourly_available) — a climatology day has no meaningful "hourly" shape,
  // so it isn't clickable rather than opening a modal that 404s.
  const clickable = weather?.source === 'forecast'
  const [showDetail, setShowDetail] = useState(false)

  return (
    <>
      <div
        onClick={clickable ? () => setShowDetail(true) : undefined}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowDetail(true) } } : undefined}
        style={{
          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: '0.375rem',
          cursor: clickable ? 'pointer' : 'default',
        }}
        className={`px-3 py-1.5 text-xs font-semibold flex items-center ${clickable ? 'hover:opacity-80 transition-opacity' : ''}`}
        title={clickable ? 'Click for hourly forecast' : undefined}
      >
        <span>{fmtDayHeader(dateKey)}</span>
        {weather && (
          <span
            style={{ color: 'var(--text-faint)' }}
            className="ml-2 font-normal"
            title={[
              weather.desc,
              weather.wind != null ? `wind ${Math.round(weather.wind)} km/h` : null,
              weather.source === 'climatology' ? 'seasonal average (live forecast nearer the date)' : 'live forecast — click for hourly detail',
            ].filter(Boolean).join(' · ')}
          >
            {weather.icon} {Math.round(weather.tmin)}–{Math.round(weather.tmax)}°C
            {weather.wind != null && (
              <span className="ml-1"><Wind size={11} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.1em' }} /> {Math.round(weather.wind)}km/h</span>
            )}
            {weather.source === 'climatology' && (
              <span style={{ fontSize: '0.85em', opacity: 0.75 }} className="ml-1">avg</span>
            )}
            {weather.source === 'forecast' && (
              <span style={{ fontSize: '0.85em', opacity: 0.75 }} className="ml-1">📡</span>
            )}
          </span>
        )}
      </div>
      {showDetail && (
        <WeatherDetailModal dateKey={dateKey} source={weatherSource} onClose={() => setShowDetail(false)} />
      )}
    </>
  )
}

// Static Maps only accepts a single A-Z/0-9 char per marker — mirrors the
// backend's own _MARKER_LABELS (backend/routers/items.py's day_map), so the
// legend below lines up letter-for-letter with the pins actually drawn.
const DAY_MAP_MARKER_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
// Mirrors the backend's _DAY_MAP_MAX_LOCATIONS — points beyond this don't
// get a pin at all, so the legend shouldn't claim one for them either.
const DAY_MAP_MAX_LOCATIONS = 12

// A flight's two pins are the same item ("SIN → HEL") with a "(start)"/
// "(end)" suffix, which doesn't say which city is which — labeling each with
// its own city (already what `location` holds; see itemLocations) is more
// useful. Every other start/end kind (rail, transfer, walk, cycling, hire)
// keeps the item-name-plus-role label, since their `location` values are
// often long freeform addresses rather than short place names.
function _dayMapPointLabel(p) {
  if (p.item.kind === 'flight' && p.role) return p.location
  return p.role ? `${p.item.name} (${p.role})` : p.item.name
}

// One Static Maps pin per distinct location touched by a day's items, plus a
// small legend overlay translating each lettered pin back to the item (and
// kind) it came from — the letters alone gave no way to tell A from B.
// Single-day (Today) view only — rendered inline, below the day's item cards
// and above the Import-from-document button, at its natural ~640x400 size
// (capped so it doesn't outgrow the content column on wide screens).
export function DayMap({ stopId, points }) {
  const [mapUrl, setMapUrl] = useState(null)
  const shown = points.slice(0, DAY_MAP_MAX_LOCATIONS)
  const locations = shown.map(p => p.location)
  const key = locations.join('|')

  useEffect(() => {
    if (!locations.length) return
    let objectUrl = null
    let cancelled = false
    fetchDayMapBlob(stopId, locations).then(blob => {
      if (cancelled || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setMapUrl(objectUrl)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setMapUrl(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopId, key])

  if (shown.length === 0) return null

  return (
    <div style={{ maxWidth: '640px', margin: '0.75rem auto 0', borderRadius: '0.5rem', overflow: 'hidden', border: '1px solid var(--border)', position: 'relative' }}>
      {mapUrl
        ? <img src={mapUrl} alt="Day locations map" style={{ display: 'block', width: '100%', height: 'auto' }} />
        : <div style={{ color: 'var(--text-faint)' }} className="text-xs px-3 py-2">Loading map…</div>}
      {/* Fixed light styling (not theme vars) — this overlays a Google
          roadmap PNG, whose own light background doesn't follow the app's
          theme, so a dark-mode-aware panel could end up unreadable on it. */}
      {mapUrl && (
        <div
          style={{
            position: 'absolute', left: '0.5rem', bottom: '0.5rem', right: '0.5rem',
            background: 'rgba(255,255,255,0.55)', color: '#1e1e2e',
            borderRadius: '0.375rem', padding: '0.35rem 0.5rem',
            maxHeight: '45%', overflowY: 'auto',
            boxShadow: '0 1px 4px rgba(0,0,0,0.35)', fontSize: '0.68rem', lineHeight: 1.5,
          }}
        >
          {shown.map((p, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span style={{ fontWeight: 700, width: '1rem', textAlign: 'center', flexShrink: 0 }}>
                {DAY_MAP_MARKER_LABELS[i]}
              </span>
              <span style={{ flexShrink: 0 }}>{KIND_ICON[p.item.kind] ?? '📍'}</span>
              <span className="truncate">{_dayMapPointLabel(p)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Flag as an image (emoji flags don't render on Chrome/Edge on Windows). Falls
// back to the emoji where no ISO code resolves.
export function FlagMark({ country }) {
  const code = countryCode(country)
  if (code) {
    return (
      <img
        src={`https://flagcdn.com/24x18/${code}.png`}
        srcSet={`https://flagcdn.com/48x36/${code}.png 2x`}
        width="24" height="18" alt={country} title={country}
        className="shrink-0" style={{ borderRadius: '2px', display: 'inline-block' }}
      />
    )
  }
  const emoji = countryFlag(country)
  return emoji ? <span className="text-base leading-none shrink-0">{emoji}</span> : null
}

// Compact one-line offline-friendly facts (plug, emergency number, driving
// side, currency, tipping norm) for the stop's country. Renders nothing when
// the country doesn't resolve to a known entry — deliberately no toggle/border,
// just a subtle faint-text line. Callers should skip any layout wrapper (e.g.
// OffsetRow) entirely when this would render null, so an unknown country
// doesn't leave a stray empty row.
function CountryFactsRow({ country }) {
  const facts = countryFacts(countryCode(country))
  if (!facts) return null
  const tipping = facts.tipping ? facts.tipping.charAt(0).toLowerCase() + facts.tipping.slice(1) : ''
  return (
    <div style={{ color: 'var(--text-faint)' }} className="text-xs">
      🔌 {facts.plug} · {facts.voltage} ⚡ · 🚨 {facts.emergency} · 🚗 {facts.driving} · 💰 {facts.currency} · tip: {tipping}
    </div>
  )
}

// Does the stop's country resolve to a known countryFacts entry? Used to
// decide whether to render CountryFactsRow's layout wrapper at all.
function hasCountryFacts(country) {
  return !!countryFacts(countryCode(country))
}

// Cards inside a TimeRow consume this to suppress their internal time display.
export const HideTimeCtx = createContext(false)
const useHideTime = () => useContext(HideTimeCtx)

const TIME_COL_W = '4rem'
const TIME_COL_GAP = '0.5rem' // gap-2

function TimeRow({ item, children }) {
  const time = itemTimeStr(item)
  const tz   = itemTz(item)
  return (
    <div className="flex items-start gap-2">
      <div className="shrink-0 text-right" style={{ width: TIME_COL_W, paddingTop: '0.6rem' }}>
        {time && <div className="text-xs font-semibold" style={{ color: 'var(--text)' }}>{time}</div>}
        {tz   && <div className="text-xs" style={{ color: 'var(--text-faint)' }}>{tz}</div>}
      </div>
      <div className="flex-1 min-w-0">
        <HideTimeCtx.Provider value={true}>{children}</HideTimeCtx.Provider>
      </div>
    </div>
  )
}

function OffsetRow({ children }) {
  return (
    <div className="flex items-start gap-2">
      <div className="shrink-0" style={{ width: TIME_COL_W }} />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

// ── Connection / layover calculation ────────────────────────────────────────
const TRANSPORT_KINDS = new Set(['flight', 'rail', 'transfer', 'river_transfer', 'cycling'])

function _arriveStr(item) {
  const d = item.details || {}
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer') return d.arrive_time || null
  // Cycling has no separate arrive_time (unlike flight/rail/river_transfer) — its
  // own scheduled_at is the only timestamp we have, so it doubles as the proxy
  // "arrival" here. Without this, a stop reached only by bike (no flight/rail
  // leg) can never seed a cross-stop connection at all.
  if (item.kind === 'cycling') return item.scheduled_at || null
  return null
}

function _departStr(item) {
  const d = item.details || {}
  return (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer') ? (d.depart_time || null) : (item.scheduled_at || null)
}

function _connectionLocation(item) {
  const d = item.details || {}
  if (item.kind === 'flight') { const c = d.destination; return c ? (airportName(c) || c) : null }
  if (item.kind === 'rail')     return d.destination || null
  if (item.kind === 'transfer') return d.end_location || null
  if (item.kind === 'river_transfer') return d.end_location || null
  if (item.kind === 'cycling')  return d.end_location || null
  return null
}

export function fmtConnectionDur(ms) {
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60), m = mins % 60
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

function _normLoc(s) {
  return String(s || '').trim().toLowerCase()
}

// Every location string an item touches, for the day map's pins. Kinds with
// no meaningful location (note, etc.) return an empty array.
export function itemLocations(item) {
  const d = item.details || {}
  switch (item.kind) {
    case 'accommodation':
    case 'restaurant':
    case 'activity':
    case 'show':
    case 'food':
    case 'purchase':
      return [d.location].filter(Boolean)
    case 'tour':
      return [d.meeting_point].filter(Boolean)
    case 'transfer':
    case 'river_transfer':
    case 'walk':
    case 'cycling':
      return [d.start_location, d.end_location].filter(Boolean)
    case 'rail':
      return [d.origin, d.destination].filter(Boolean)
    case 'flight':
      // Flight stores IATA codes — resolve to a city name so Static Maps has
      // something a geocoder can actually place a pin on.
      return [d.origin, d.destination].filter(Boolean).map(c => airportName(c) || c)
    case 'hire':
      return [d.pickup_location, d.dropoff_location].filter(Boolean)
    default:
      return []
  }
}

// Deduplicated (case/whitespace-insensitive), order-preserving location list
// across every item in a day — what the day map's pins are built from.
export function dayLocations(items) {
  const seen = new Set()
  const out = []
  for (const item of items || []) {
    for (const loc of itemLocations(item)) {
      const key = _normLoc(loc)
      if (key && !seen.has(key)) { seen.add(key); out.push(loc) }
    }
  }
  return out
}

// Same dedup as dayLocations, but keeps each pin's originating item (and,
// for start/end pairs like a flight or transfer, which end it is) — what the
// day map's legend labels its lettered pins with. dayLocations itself stays
// string-only: the Static Maps request (and its own tests) depend on that
// exact shape.
//
// `activeDay` (the Today view's selected "YYYY-MM-DD") is only used for a
// flight that crosses midnight (depart/arrive dates differ): itemOccursOn
// already includes such a flight in both the departure day's and the
// arrival day's item list, which would otherwise plot the same two-city
// route redundantly on both days. Instead, the departure day's map gets only
// the origin, and the arrival day's map gets only the destination — placed
// first, since it's the first thing to happen on that arrival day.
//
// A road transfer whose start AND end both already have a pin from some
// other (non-transfer) item that day — e.g. hotel -> restaurant, when the
// accommodation and restaurant items already plot those same two points —
// adds nothing new to the map, so it's dropped rather than drawing a
// redundant already-there-to-already-there pair. This is scoped to plain
// road transfers only (not rail/river_transfer/walk/cycling/hire): those
// still show even when their endpoints coincide with another pin.
export function dayMapPoints(items, activeDay) {
  const list = items || []
  const otherLocs = new Set()
  for (const item of list) {
    if (item.kind === 'transfer') continue
    for (const loc of itemLocations(item)) {
      const key = _normLoc(loc)
      if (key) otherLocs.add(key)
    }
  }

  const seen = new Set()
  const arrivals = []
  const rest = []
  for (const item of list) {
    const locs = itemLocations(item)
    const isPair = locs.length > 1

    if (item.kind === 'transfer' && isPair &&
        otherLocs.has(_normLoc(locs[0])) && otherLocs.has(_normLoc(locs[1]))) {
      continue
    }

    const d = item.details || {}
    const crossesMidnight = item.kind === 'flight' && isPair && d.depart_time && d.arrive_time &&
      String(d.depart_time).split('T')[0] !== String(d.arrive_time).split('T')[0]

    locs.forEach((loc, i) => {
      const role = isPair ? (i === 0 ? 'start' : 'end') : null
      let isCrossDayArrival = false
      if (crossesMidnight && activeDay) {
        const depDate = String(d.depart_time).split('T')[0]
        const arrDate = String(d.arrive_time).split('T')[0]
        if (role === 'start' && activeDay !== depDate) return  // arrival day's map: skip the origin
        if (role === 'end' && activeDay !== arrDate) return    // departure day's map: skip the destination
        if (role === 'end') isCrossDayArrival = true
      }
      const key = _normLoc(loc)
      if (key && !seen.has(key)) {
        seen.add(key)
        const point = { location: loc, item, role }
        ;(isCrossDayArrival ? arrivals : rest).push(point)
      }
    })
  }
  return [...arrivals, ...rest]
}

// Wraps a rendered item card with a distinct warning-tinted frame when the
// item is past-pending — the catch-up banner (TripTimeline.jsx) says how
// many, but gave no way to spot *which* one(s) among a long itinerary.
export function PastPendingFrame({ item, children }) {
  if (!isPastPending(item)) return children
  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--warning) 45%, transparent)',
        borderRadius: '0.625rem',
        padding: '0.375rem',
      }}
    >
      <p style={{ color: 'var(--warning)' }} className="text-xs font-medium px-0.5 pb-1 flex items-center gap-1">
        <span aria-hidden="true">⚠</span> Past pending
      </p>
      {children}
    </div>
  )
}

// A stop's weather is normally fetched once for its own location/date span.
// That breaks down for a multi-port cruise matched to a single stop: each
// night's accommodation item has its own town, which can differ from (or
// simply exist when) the stop has none at all. For every accommodation item
// whose own location differs from the stop's, return a separate lookup
// segment {start, end, query} — a plain string comparison, not distance math,
// since a traveller-entered location differing from the stop's name is
// already a strong, cheap signal it's genuinely a different place.
export function weatherSegments(stop, items) {
  const stopKey = _normLoc(stop.location)
  const segments = []
  for (const item of items || []) {
    if (item.kind !== 'accommodation') continue
    const loc = item.details?.location
    if (!loc || _normLoc(loc) === stopKey) continue
    const start = item.details?.checkin ? String(item.details.checkin).split('T')[0] : null
    if (!start) continue
    const end = item.details?.checkout ? String(item.details.checkout).split('T')[0] : start
    segments.push({ start, end, query: loc })
  }
  return segments
}

// A stop can hold more than one accommodation item (e.g. a multi-port cruise
// matched to a single stop) — pick the one with the LAST checkout, not just
// the first accommodation item encountered in array order.
export function latestCheckoutAccommodation(items) {
  return (items || [])
    .filter(i => i.kind === 'accommodation' && i.details?.checkout)
    .reduce((latest, i) => (!latest || i.details.checkout > latest.details.checkout) ? i : latest, null)
}

export function computeCrossStopLayover(fromStop, toStop) {
  // Last transport arrival in fromStop (UTC-aware)
  let latestArr = null, latestArrMs = null
  for (const it of (fromStop.items || [])) {
    if (!TRANSPORT_KINDS.has(it.kind)) continue
    const t = _arriveStr(it)
    if (!t) continue
    const ms = toUtcMs(t, (it.details || {}).arrive_tz)
    if (!ms) continue
    if (!latestArrMs || ms > latestArrMs) { latestArr = it; latestArrMs = ms }
  }
  if (!latestArr) return null

  // First item of ANY kind in toStop (UTC-aware)
  let earliestMs = null
  for (const it of (toStop.items || [])) {
    const ms = _itemStartMs(it)
    if (!ms) continue
    if (!earliestMs || ms < earliestMs) earliestMs = ms
  }
  if (!earliestMs) return null

  const ms = earliestMs - latestArrMs
  if (ms <= 0 || ms > 86400000) return null
  return { duration: fmtConnectionDur(ms), location: _connectionLocation(latestArr) }
}

// UTC start-time for any item (for layover calculations)
function _itemStartMs(item) {
  const d = item.details || {}
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer')
    return toUtcMs(d.depart_time, d.depart_tz)
  if (item.kind === 'accommodation')
    return toUtcMs(d.checkin || item.scheduled_at, null)
  return toUtcMs(item.scheduled_at, null)
}

// Sort key for a stop's own item timeline (visual ordering within one place).
// Every item here shares the stop's location, so times compare as local
// wall-clock — unlike _itemStartMs, a flight's depart_time is NOT shifted by
// its tz, or it would be compared against a different reference frame than
// the naive scheduled_at used by every other kind and sort out of place.
export function itemSortKey(item) {
  const d = item.details || {}
  if (item.kind === 'flight' || item.kind === 'rail' || item.kind === 'river_transfer')
    return toUtcMs(d.depart_time, null) ?? Infinity
  if (item.kind === 'accommodation') {
    const checkin = toUtcMs(d.checkin || item.scheduled_at, null) ?? Infinity
    if (!d.bag_drop) return checkin
    // Project bag-drop time-of-day onto the check-in date so a bag drop on
    // a prior day (e.g. Sat drop → Sun check-in) still sorts within the
    // check-in day's timeline rather than before all same-day items.
    const checkinDate = (d.checkin || item.scheduled_at || '').slice(0, 10)
    const bagTime     = String(d.bag_drop).slice(11)   // "HH:MM…"
    if (checkinDate && bagTime) {
      const projected = toUtcMs(`${checkinDate}T${bagTime}`, null) ?? Infinity
      return Math.min(projected, checkin)
    }
    return Math.min(toUtcMs(d.bag_drop, null) ?? Infinity, checkin)
  }
  return toUtcMs(item.scheduled_at, null) ?? Infinity
}

export function computeLayovers(sortedItems) {
  // Sort ALL items by UTC start time — connection ends at next item of any kind
  const all = sortedItems
    .map(it => ({ it, ms: _itemStartMs(it) }))
    .filter(x => x.ms !== null)
    .sort((a, b) => a.ms - b.ms)

  const out = {}
  for (let i = 0; i < all.length; i++) {
    const cur = all[i].it
    if (!TRANSPORT_KINDS.has(cur.kind)) continue
    const arrStr = _arriveStr(cur)
    if (!arrStr) continue
    const arrMs = toUtcMs(arrStr, (cur.details || {}).arrive_tz)
    if (!arrMs) continue
    // Use the immediately next item in chronological order.
    // If it starts before this transport arrives, we're already committed — no gap.
    const next = all[i + 1]
    if (!next || next.ms <= arrMs) continue
    const ms = next.ms - arrMs
    if (ms <= 0 || ms > 86400000) continue
    out[cur.id] = { duration: fmtConnectionDur(ms), location: _connectionLocation(cur) }
  }
  return out
}

// Warning chip for cards whose venue's stored opening_hours (from the Places
// enrich flow) list the item's scheduled date as closed. Renders nothing when
// there's no opening_hours, no resolvable date, or the day isn't closed.
function ClosedChip({ item }) {
  const d = item.details ?? {}
  const dateKey = itemDateKey(item)
  if (!closedOnDay(d.opening_hours, dateKey)) return null
  const weekday = new Date(`${dateKey}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' })
  return (
    <span
      style={{ color: 'var(--warning)' }}
      className="text-xs"
      title="This venue's stored hours list this day as closed"
    >
      ⚠ Closed on {weekday}
    </span>
  )
}

function LayoverBadge({ duration, location }) {
  return (
    <div className="flex items-center gap-1.5 py-0.5"
         style={{ color: 'var(--text-faint)', fontSize: '0.73rem' }}>
      <span>⏱</span>
      <span>
        <span className="font-medium" style={{ color: 'var(--text-muted)' }}>{duration}</span>
        {' '}connection{location && <span> in {location}</span>}
      </span>
    </div>
  )
}

export default function StopCard({ stop, index, onUpdate, inbound, hideFrame = false, inboundConnection = null, skipDays = null, onItemAdded, forceOpen = false, tripId = null }) {
  const [open, setOpen] = useState(index === 0)
  const [status, setStatus] = useState(stop.status)
  const [busy, setBusy] = useState(false)
  const [itemEdits, setItemEdits] = useState({})  // Only track local edits, not synced items
  const [showAddExpense, setShowAddExpense] = useState(false)
  const canEdit = useCanEdit()
  const canQueueEdit = useCanQueueEdit()

  // Use stop.items directly instead of syncing to local state—this ensures fresh data
  const items = stop.items

  // Weather for the day headers: forecast/climatology over the stop's date span.
  // Prefer arrive→depart so the span matches the server-side daily warm (which
  // works off the same fields), keeping cache keys identical. Falls back to the
  // item date range when a stop has no arrive/depart.
  const [weather, setWeather] = useState({})
  const _arr = stop.arrive ? String(stop.arrive).split('T')[0] : null
  const _dep = stop.depart ? String(stop.depart).split('T')[0] : null
  const _dayKeys = items.map(itemDateKey).filter(Boolean).sort()
  const wxStart = _arr || _dayKeys[0] || null
  const wxEnd   = _dep || _dayKeys[_dayKeys.length - 1] || _arr || null
  // Place-name fallback so stops without stored coords (e.g. home) still resolve.
  const wxQuery = stop.location ? [stop.location, stop.country].filter(Boolean).join(', ') : ''
  // Per-night overrides for stops whose own location doesn't represent every
  // day (e.g. a multi-port cruise) — see weatherSegments().
  const segments = weatherSegments(stop, items)
  const segmentsKey = JSON.stringify(segments)
  // Mirrors the merge in the effect below (segment overrides win on their
  // dates) so a day's click-through hourly fetch queries the exact same
  // place its summary weather came from.
  function weatherSourceFor(dateKey) {
    const seg = segments.find(s => s.start <= dateKey && dateKey <= s.end)
    if (seg) return { lat: null, lng: null, query: seg.query }
    return { lat: stop.lat, lng: stop.lng, query: wxQuery }
  }
  // In headerless (frameless) mode every stop's content is always shown, so we
  // must fetch regardless of `open`; in framed mode fetch when expanded, or
  // when forced open (e.g. Today view — a collapsed stop there would hide the
  // one thing the single-day view exists to show).
  const contentVisible = hideFrame || open || forceOpen
  useEffect(() => {
    if (!contentVisible) return
    const hasBase = wxStart && wxEnd && (stop.lat || stop.lng || wxQuery)
    if (!hasBase && segments.length === 0) return
    let cancelled = false
    const lookups = [
      hasBase ? getWeather(stop.lat, stop.lng, wxStart, wxEnd, wxQuery) : Promise.resolve({ weather: {} }),
      ...segments.map(seg => getWeather(null, null, seg.start, seg.end, seg.query)),
    ]
    Promise.all(lookups)
      .then(results => {
        if (cancelled) return
        // Segment (per-night) results are more specific than the stop-level
        // base, so they're merged in afterwards and win on overlapping dates.
        const merged = {}
        for (const r of results) Object.assign(merged, r.weather || {})
        setWeather(merged)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [contentVisible, stop.lat, stop.lng, wxQuery, wxStart, wxEnd, segmentsKey])

  function handleItemSaved(updated) {
    // Refresh parent timeline to get fresh data with the update
    onUpdate?.()
  }

  function handleItemDeleted(id) {
    // Refresh parent timeline to remove the item
    onUpdate?.()
  }

  function handleItemAdded(newItem) {
    onItemAdded?.(newItem)
    // Refresh parent timeline to include the new item
    onUpdate?.()
  }


  const hideCompleted = useHideCompleted()
  const kindFilter    = useKindFilter()
  const visibleItems = items
    .filter(i => !isHiddenWhenCompleted(i, hideCompleted))
    .filter(i => !kindFilter || i.kind === kindFilter)

  // Important notes are pinned to the very top of the stop; everything else flows
  // chronologically (by check-in / arrival). Food & purchases stay grouped.
  const isImportant = i => i.kind === 'note' && i.details?.important
  const timeline = visibleItems
    .filter(i => i.kind !== 'food' && i.kind !== 'purchase')
    .sort((a, b) => {
      const ia = isImportant(a) ? 0 : 1, ib = isImportant(b) ? 0 : 1
      if (ia !== ib) return ia - ib
      return itemSortKey(a) - itemSortKey(b)
    })
  const foodItems = visibleItems.filter(i => i.kind === 'food')
  const purchaseItems = visibleItems.filter(i => i.kind === 'purchase')

  const checkoutAccom = latestCheckoutAccommodation(items)

  async function cycleStatus(e) {
    e.stopPropagation()
    if (busy || (!canEdit && !canQueueEdit)) return
    const next = STATUS_CYCLE[status]
    const prev = status
    setStatus(next); setBusy(true)
    try {
      if (canQueueEdit) {
        // Offline: queue the write and apply it optimistically — no network
        // round trip, no onUpdate() (there's nothing fresher to refetch).
        await offlineQueue.enqueue({ entity: 'stop', entityId: stop.id, changes: { status: next }, base: { status: prev } })
      } else {
        await updateStopStatus(stop.id, next); onUpdate()
      }
    }
    catch { setStatus(prev) }
    finally { setBusy(false) }
  }

  if (hideFrame) {
    return (
      <>
      <div className="space-y-2">
        {hasCountryFacts(stop.country) && <OffsetRow><CountryFactsRow country={stop.country} /></OffsetRow>}
        {inbound && <OffsetRow><InboundBanner inbound={inbound} onUpdate={onUpdate} /></OffsetRow>}
        {inboundConnection && <OffsetRow><LayoverBadge {...inboundConnection} /></OffsetRow>}
        {timeline.length > 0 && (() => {
          const byDate = {}
          const undated = []
          for (const item of timeline) {
            const dk = itemDateKey(item)
            if (dk) { if (!byDate[dk]) byDate[dk] = []; byDate[dk].push(item) }
            else undated.push(item)
          }
          const sortedDates = Object.keys(byDate).sort()
          const layovers = computeLayovers(timeline)
          function renderCard(item) {
            const props = { item, onItemSaved: handleItemSaved, onItemDeleted: handleItemDeleted }
            let card
            if (item.kind === 'accommodation') card = <AccomCard {...props} />
            else if (item.kind === 'flight')        card = <FlightCard {...props} />
            else if (item.kind === 'rail')          card = <RailCard {...props} />
            else if (item.kind === 'restaurant')    card = <RestaurantCard {...props} />
            else if (item.kind === 'cycling')       card = <CyclingCard {...props} />
            else if (item.kind === 'walk')          card = <WalkCard {...props} />
            else if (item.kind === 'transfer')      card = <TransferCard {...props} />
            else if (item.kind === 'river_transfer') card = <RiverTransferCard {...props} />
            else if (item.kind === 'tour')          card = <TourCard {...props} />
            else if (item.kind === 'note')          card = <NoteCard {...props} />
            else if (item.kind === 'activity')      card = <ActivityCard {...props} />
            else if (item.kind === 'show')          card = <ShowCard {...props} />
            else if (item.kind === 'hire')          card = <HireCard {...props} />
            else card = <ItemRow {...props} />
            return <PastPendingFrame key={item.id} item={item}>{card}</PastPendingFrame>
          }
          return (
            <>
              {sortedDates.map(dk => {
                const showBanner = !skipDays?.has(dk)
                return (
                  <div key={dk} className="space-y-1">
                    {showBanner && <DayBanner dateKey={dk} weather={weather[dk]} weatherSource={weatherSourceFor(dk)} />}
                    {byDate[dk].flatMap(item => [
                      <TimeRow key={item.id} item={item}>{renderCard(item)}</TimeRow>,
                      layovers[item.id] && <OffsetRow key={`lay-${item.id}`}><LayoverBadge {...layovers[item.id]} /></OffsetRow>,
                    ].filter(Boolean))}
                  </div>
                )
              })}
              {undated.map(item => (
                <TimeRow key={item.id} item={item}>{renderCard(item)}</TimeRow>
              ))}
            </>
          )
        })()}
        {foodItems.map(item => <OffsetRow key={item.id}><FoodCard item={item} onItemSaved={handleItemSaved} onItemDeleted={handleItemDeleted} /></OffsetRow>)}
        {purchaseItems.map(item => <OffsetRow key={item.id}><PurchaseCard item={item} onItemSaved={handleItemSaved} onItemDeleted={handleItemDeleted} /></OffsetRow>)}
      </div>
    </>
    )
  }

  return (
    <>
    <div
      style={{
        background: 'var(--surface)',
        borderRadius: '0.75rem',
        overflow: 'hidden',
        borderLeft: `3px solid var(--status-${status})`,
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-2.5 py-3.5 flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <FlagMark country={stop.country} />
          <span className="font-medium text-sm truncate">{stop.location}</span>
          {(stop.arrive || stop.depart) && (
            <span style={{ color: 'var(--text-faint)' }} className="text-xs shrink-0">
              {fmtDate(stop.arrive)}{stop.depart ? ` → ${fmtDate(stop.depart)}` : ''}
            </span>
          )}
        </div>
        <button
          onClick={cycleStatus}
          style={{ color: `var(--status-${status})`, fontSize: '0.65rem' }}
          className="capitalize hover:opacity-70 transition-opacity shrink-0 font-medium"
        >
          {status}
        </button>
        <span style={{ color: 'var(--text-faint)', fontSize: '0.6rem' }}>{contentVisible ? '▲' : '▼'}</span>
      </button>

      {/* Tight horizontal padding on purpose: the item cards' own rounded
          borders / left strips provide the visual separation from the stop
          frame, so wide gutters here just waste phone-width. */}
      {contentVisible && (
        <div style={{ borderTop: '1px solid var(--border)' }} className="px-1.5 py-3 space-y-4">
          <CountryFactsRow country={stop.country} />
          <InboundBanner inbound={inbound} onUpdate={onUpdate} />
          {inboundConnection && <LayoverBadge {...inboundConnection} />}

          {timeline.length > 0 && (() => {
            const byDate = {}
            const undated = []
            for (const item of timeline) {
              const dk = itemDateKey(item)
              if (dk) { if (!byDate[dk]) byDate[dk] = []; byDate[dk].push(item) }
              else undated.push(item)
            }
            const sortedDates = Object.keys(byDate).sort()
            const layovers = computeLayovers(timeline)
            function renderCard(item) {
              const props = { item, onItemSaved: handleItemSaved, onItemDeleted: handleItemDeleted }
              let card
              if (item.kind === 'accommodation') card = <AccomCard {...props} />
              else if (item.kind === 'flight')        card = <FlightCard {...props} />
              else if (item.kind === 'rail')          card = <RailCard {...props} />
              else if (item.kind === 'restaurant')    card = <RestaurantCard {...props} />
              else if (item.kind === 'cycling')       card = <CyclingCard {...props} />
              else if (item.kind === 'walk')          card = <WalkCard {...props} />
              else if (item.kind === 'transfer')      card = <TransferCard {...props} />
              else if (item.kind === 'river_transfer') card = <RiverTransferCard {...props} />
              else if (item.kind === 'tour')          card = <TourCard {...props} />
              else if (item.kind === 'note')          card = <NoteCard {...props} />
              else if (item.kind === 'activity')      card = <ActivityCard {...props} />
              else if (item.kind === 'show')          card = <ShowCard {...props} />
              else if (item.kind === 'hire')          card = <HireCard {...props} />
              else card = <ItemRow {...props} />
              return <PastPendingFrame key={item.id} item={item}>{card}</PastPendingFrame>
            }
            return (
              <div className="space-y-2">
                {sortedDates.map(dk => (
                  <div key={dk} className="space-y-1">
                    <DayBanner dateKey={dk} weather={weather[dk]} weatherSource={weatherSourceFor(dk)} />
                    {byDate[dk].flatMap(item => [
                      renderCard(item),
                      layovers[item.id] && <LayoverBadge key={`lay-${item.id}`} {...layovers[item.id]} />,
                    ].filter(Boolean))}
                  </div>
                ))}
                {undated.map(item => renderCard(item))}
              </div>
            )
          })()}

          {foodItems.length > 0 && (
            <Section label="Food & Drink">
              {foodItems.map(item => <FoodCard key={item.id} item={item} onItemSaved={handleItemSaved} onItemDeleted={handleItemDeleted} />)}
            </Section>
          )}

          {purchaseItems.length > 0 && (
            <Section label="Purchases">
              {purchaseItems.map(item => <PurchaseCard key={item.id} item={item} onItemSaved={handleItemSaved} onItemDeleted={handleItemDeleted} />)}
            </Section>
          )}

          {timeline.length === 0 && foodItems.length === 0 && purchaseItems.length === 0 && (
            <p style={{ color: 'var(--text-faint)' }} className="text-xs">No details recorded.</p>
          )}


          {checkoutAccom && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--kind-accommodation) 8%, var(--surface-2))',
                border: '1px dashed color-mix(in srgb, var(--kind-accommodation) 40%, transparent)',
                borderRadius: '0.5rem',
              }}
              className="px-3 py-2 flex items-center gap-2 text-xs"
            >
              <span style={{ color: 'var(--kind-accommodation)' }}><BedDouble size={13} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }} /></span>
              <span style={{ color: 'var(--kind-accommodation)' }} className="font-medium whitespace-nowrap shrink-0">Check out</span>
              <span style={{ color: 'var(--text)' }} className="truncate">{checkoutAccom.name}</span>
              <span style={{ color: 'var(--text-faint)' }} className="ml-auto shrink-0">{fmtDayTime(checkoutAccom.details.checkout)}</span>
            </div>
          )}

          {canEdit && tripId && (
            <button
              onClick={() => setShowAddExpense(true)}
              style={{ color: 'var(--text-faint)' }}
              className="text-xs hover:opacity-70"
            >
              + Log expense
            </button>
          )}
        </div>
      )}

    </div>

    {showAddExpense && (
      <ExpenseQuickAdd
        tripId={tripId} stopId={stop.id} items={items}
        onSaved={() => onUpdate?.()}
        onClose={() => setShowAddExpense(false)}
      />
    )}

    </>
  )
}

function Section({ label, children }) {
  return (
    <div>
      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2 font-medium">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

// Clickable leading icon — toggles completion (done ↔ pending). Shows ✓ when done.
// Viewers (no edit rights) see a static icon with no toggle.
function CardIcon({ item, color, setItem, onItemSaved }) {
  const canEdit = useCanEdit()
  const canQueueEdit = useCanQueueEdit()
  const clickable = canEdit || canQueueEdit
  const done = item.status === 'done'
  async function toggle(e) {
    e.stopPropagation()
    if (!clickable) return
    const next = done ? 'pending' : 'done'
    const prev = item
    const updated = { ...item, status: next }
    setItem(updated); onItemSaved?.(updated)
    try {
      if (canQueueEdit) {
        await offlineQueue.enqueue({ entity: 'item', entityId: item.id, changes: { status: next }, base: { status: item.status } })
      } else {
        await updateItemStatus(item.id, next)
      }
    }
    catch { setItem(prev); onItemSaved?.(prev) }
  }
  return (
    <span
      onClick={clickable ? toggle : undefined}
      title={clickable ? (done ? 'Mark as not done' : 'Mark as done') : undefined}
      style={{ color: done ? 'var(--success)' : color, fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0, cursor: clickable ? 'pointer' : 'default' }}
      className={clickable ? 'hover:opacity-70 transition-opacity' : ''}
    >
      {done ? <Check size={15} strokeWidth={2.5} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }} /> : <KindIcon kind={item.kind} details={item.details} />}
    </span>
  )
}

// Hover edit pencil — renders nothing for viewers. Also stays available
// offline for a real editor (useCanQueueEdit): the modal it opens routes
// Save through the offline queue for them.
function EditPencil({ onClick, absolute = true }) {
  const canEdit = useCanEdit()
  const canQueueEdit = useCanQueueEdit()
  if (!canEdit && !canQueueEdit) return null
  return (
    <button
      onClick={onClick}
      className={`edit-btn ${absolute ? 'absolute top-2 right-2 ' : ''}opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity`}
      style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
      title="Edit"
      aria-label="Edit"
    ><Pencil size={12} aria-hidden="true" /></button>
  )
}

// "Arriving here" banner — surfaces the inbound flight/rail's arrival details on the
// destination stop. Read-only summary; tapping opens the full detail modal.
function InboundBanner({ inbound, onUpdate }) {
  const show = useShowInbound()
  const [showDetail, setShowDetail] = useState(false)
  if (!show || !inbound) return null

  const d = inbound.details ?? {}
  const kind = inbound.kind
  const isFlight = kind === 'flight'
  const isRail = kind === 'rail'
  const isTransfer = kind === 'transfer'

  const color = isFlight ? 'var(--kind-flight)' : isRail ? 'var(--kind-rail)' : 'var(--kind-transfer)'
  const dest = isFlight ? (d.destination ? airportName(d.destination) : '') : (d.destination || d.end_location || '')
  const arriveTime = d.arrive_time || (isTransfer ? inbound.scheduled_at : null)
  const label = [d.flight_number || d.train_number, d.airline || d.operator || d.provider].filter(Boolean).join(' · ')
  const arrivePlace = isFlight
    ? [d.arrive_terminal && `T${d.arrive_terminal}`, d.arrive_gate && `Gate ${d.arrive_gate}`].filter(Boolean).join(' ')
    : isRail ? (d.arrive_platform ? `Plat. ${d.arrive_platform}` : '')
    : ''

  return (
    <>
      <button
        onClick={() => setShowDetail(true)}
        className="w-full text-left hover:opacity-80 transition-opacity"
        style={{
          background: `color-mix(in srgb, ${color} 10%, var(--surface-2))`,
          border: `1px dashed color-mix(in srgb, ${color} 45%, transparent)`,
          borderRadius: '0.5rem',
          padding: '0.6rem 0.75rem',
        }}
      >
        <div className="flex items-start gap-2.5">
          <span style={{ color, fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}><KindIcon kind={kind} details={d} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium" style={{ color }}>
              Arriving{dest ? ` · ${dest}` : ''}
            </div>
            <div style={{ color: 'var(--text-muted)' }} className="text-xs mt-0.5 flex gap-3 flex-wrap">
              {arriveTime && <span>{fmtDayTime(arriveTime)}{d.arrive_tz ? ` ${d.arrive_tz}` : ''}</span>}
              {arrivePlace && <span>{arrivePlace}</span>}
              {label && <span style={{ color: 'var(--text-faint)' }}>{label}</span>}
            </div>
          </div>
        </div>
      </button>
      {showDetail && (
        isFlight ? (
          <FlightDetailModal item={inbound} onClose={() => setShowDetail(false)} onSave={() => onUpdate?.()} />
        ) : isRail ? (
          <RailDetailModal item={inbound} onClose={() => setShowDetail(false)} onSave={() => onUpdate?.()} />
        ) : (
          <ItemEditModal item={inbound} onClose={() => setShowDetail(false)} onSave={() => onUpdate?.()} />
        )
      )}
    </>
  )
}

function FlightCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}
  const route = [d.origin, d.destination].filter(Boolean).map(airportName).join(' → ') || item.name || 'Flight'
  const depTerm = [d.origin_terminal && `T${d.origin_terminal}`, d.origin_gate && `Gate ${d.origin_gate}`].filter(Boolean).join(' ')
  const checkinAt = calcCheckinTime(d.depart_time, parseCheckinWindow(d.checkin_window))
  const checkinLabel = checkinAt ? `Check-in ${fmtDayTime(checkinAt)}` : null
  const meta = [d.fare_class, depTerm, d.seats && `Seat ${d.seats}`, checkinLabel].filter(Boolean).join(' · ')

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-flight) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-flight)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-flight)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm">{route}</span>
                <span style={{ color: 'var(--kind-flight)' }} className="text-xs shrink-0 opacity-80">
                  {[d.flight_number, d.airline].filter(Boolean).join(' · ')}
                </span>
              </div>
              {(d.depart_time || d.arrive_time) && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs">
                  {[d.depart_time && fmtDateTime(d.depart_time), d.arrive_time && fmtDateTime(d.arrive_time)]
                    .filter(Boolean).join(' → ')}
                  {d.duration && <span style={{ color: 'var(--text-faint)' }}> · {d.duration}</span>}
                </div>
              )}
              {meta && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs">{meta}</div>
              )}
              {item.cost && !isFullyPaid(item) && (
                <div className="text-xs"><CostDisplay item={item} compact /></div>
              )}
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <FlightDetailModal item={item} onClose={() => setShowDetail(false)} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function RailCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}
  const route = [d.origin, d.destination].filter(Boolean).join(' → ')

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-rail) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-rail)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-rail)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm">{route || item.name}</span>
                <span style={{ color: 'var(--kind-rail)' }} className="text-xs shrink-0 opacity-80">
                  {[d.train_number, d.operator].filter(Boolean).join(' · ')}
                </span>
              </div>
              {(d.depart_platform || d.arrive_platform) && (
                <div style={{ color: 'var(--kind-rail)' }} className="text-xs flex gap-3 opacity-80">
                  {d.depart_platform && <span>Dep Plat. {d.depart_platform}</span>}
                  {d.arrive_platform && <span>Arr Plat. {d.arrive_platform}</span>}
                </div>
              )}
              {(d.rail_class || d.seats) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3">
                  {d.rail_class && <span>{d.rail_class}</span>}
                  {d.seats && <span>Seats: {d.seats}</span>}
                </div>
              )}
              {(d.depart_time || d.arrive_time) && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs">
                  {[d.depart_time && fmtDateTime(d.depart_time),
                    d.arrive_time && fmtDateTime(d.arrive_time)]
                    .filter(Boolean).join(' → ')}
                  {d.duration && <span style={{ color: 'var(--text-faint)' }}> · {d.duration}</span>}
                </div>
              )}
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <RailDetailModal item={item} onClose={() => setShowDetail(false)} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function AccomCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const hideTime = useHideTime()
  const d = item.details ?? {}

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-accommodation) 8%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-accommodation)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-accommodation)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-medium text-sm">{item.name}</div>
              {d.location && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs">{d.location}</div>
              )}
              {item.cost && !isFullyPaid(item) && (
                <div className="text-xs"><CostDisplay item={item} compact /></div>
              )}
              {!hideTime && (d.bag_drop || d.checkin || d.checkout) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs">
                  {[d.bag_drop && `Bag drop: ${fmtDateTime(d.bag_drop)}`,
                    d.checkin && `In: ${fmtDateTime(d.checkin)}`,
                    d.checkout && `Out: ${fmtDateTime(d.checkout)}`]
                    .filter(Boolean).join('  ·  ')}
                </div>
              )}
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

// Which map source a walk/cycling card should use. A recorded/generated GPX
// track (gpx_route) is the literal path, so it's preferred over recomputing a
// Directions-API route between named waypoints — which can diverge from what
// was actually walked or ridden. embedUrl is only built as a fallback when
// there's no GPX track to trace. `mode` is the Google dirflg for that
// fallback embed ('w' walking, 'b' bicycling).
export function routeMapSource(details, mode = 'w') {
  const d = details ?? {}
  const hasGpxRoute = d.gpx_route?.length >= 2
  // Full ordered route (incl. intermediate waypoints) when available, else start/end.
  const routePts = d.route_points?.length >= 2 ? d.route_points : [d.start_location, d.end_location].filter(Boolean)
  const embedUrl = !hasGpxRoute && routePts.length ? buildMapsUrl(routePts, mode, true) : null
  // Link for "Open in Maps" — prefer the stored original URL (preserves all waypoints)
  const mapsLink = d.maps_url || (routePts.length ? buildMapsUrl(routePts, mode, false) : null)
  return { hasGpxRoute, embedUrl, mapsLink }
}

function WalkCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [gpxMapUrl, setGpxMapUrl] = useState(null)
  const d = item.details ?? {}
  const route = [d.start_location, d.end_location].filter(Boolean).join(' → ')
  const timeStr = fmtDayTime(item.scheduled_at)
  const hideTime = useHideTime()

  const { hasGpxRoute, embedUrl, mapsLink } = routeMapSource(d)

  useEffect(() => {
    if (!showMap || !hasGpxRoute) return
    let objectUrl = null
    let cancelled = false
    fetchGpxMapBlob(item.id).then(blob => {
      if (cancelled || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setGpxMapUrl(objectUrl)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setGpxMapUrl(null)
    }
  }, [showMap, hasGpxRoute, item.id])

  return (
    <>
      <div
        style={{
          background: 'color-mix(in srgb, var(--kind-walk) 6%, var(--surface-2))',
          border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-walk)`, boxShadow: 'var(--card-shadow)',
          borderRadius: '0.5rem',
          overflow: 'hidden',
        }}
      >
        {/* Card header */}
        <div className="relative group">
          <button
            onClick={() => setShowDetail(true)}
            className="w-full text-left hover:opacity-80 transition-opacity"
            style={{ padding: '0.75rem' }}
          >
            <div className="flex items-start gap-2.5">
              <CardIcon item={item} color="var(--kind-walk)" setItem={setItem} onItemSaved={onItemSaved} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-sm truncate">{item.name}</span>
                  {d.difficulty && (
                    <span style={{ color: 'var(--kind-walk)' }} className="text-xs shrink-0 opacity-80 capitalize">{d.difficulty}</span>
                  )}
                </div>
                {route && !d.description && (
                  <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">{route}</div>
                )}
                {d.description && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs"><RichText>{d.description}</RichText></div>
                )}
                {(timeStr || d.distance || d.elevation_gain || d.elevation_loss || d.duration) && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                    {!hideTime && timeStr && <span style={{ color: 'var(--text-muted)' }}>{timeStr}</span>}
                    {d.distance       && <span>↔ {d.distance}</span>}
                    {d.elevation_gain && <span>↑ {d.elevation_gain}</span>}
                    {d.elevation_loss && <span>↓ {d.elevation_loss}</span>}
                    {d.duration       && <span>⏱ {d.duration}</span>}
                  </div>
                )}
              </div>
            </div>
          </button>
          <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
        </div>

        {/* Map controls — only when we have location or GPX-track data */}
        {(embedUrl || hasGpxRoute) && (
          <div
            className="flex items-center gap-3 px-3 py-1.5"
            style={{ borderTop: '1px solid color-mix(in srgb, var(--kind-walk) 20%, transparent)' }}
          >
            <button
              onClick={() => setShowMap(m => !m)}
              style={{ color: 'var(--kind-walk)' }}
              className="text-xs hover:opacity-70 transition-opacity"
            >
              {showMap ? '▲ Hide map' : '▼ Show map'}
            </button>
            {mapsLink && (
              <a
                href={mapsLink}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--text-faint)' }}
                className="text-xs hover:opacity-70 transition-opacity ml-auto"
              >
                Open in Maps ↗
              </a>
            )}
          </div>
        )}

        {/* Traced GPX track (the literal recorded path) when available */}
        {showMap && hasGpxRoute && (
          gpxMapUrl
            ? <img src={gpxMapUrl} alt="Recorded route"
                style={{ display: 'block', width: '100%', height: '280px', objectFit: 'contain', background: 'transparent' }} />
            : <div style={{ color: 'var(--text-faint)' }} className="text-xs px-3 py-2">Loading map…</div>
        )}

        {/* Embedded Directions map — fallback when no GPX track is stored */}
        {showMap && embedUrl && (
          <iframe
            src={embedUrl}
            title="Route map"
            width="100%"
            height="280"
            style={{ border: 'none', display: 'block' }}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        )}
      </div>

      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function TourCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showEdit, setShowEdit] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const d = item.details ?? {}

  const timeStr = fmtDayTime(item.scheduled_at)
  const hideTime = useHideTime()

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-tour) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-tour)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-tour)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm truncate">{item.name}</span>
                <span style={{ color: 'var(--kind-tour)' }} className="text-xs shrink-0 opacity-80 capitalize flex gap-1.5">
                  {d.operator && <span>{d.operator}</span>}
                  {d.tour_type && <span>{d.tour_type}</span>}
                </span>
              </div>
              {d.meeting_point && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">📍 {d.meeting_point}</div>
              )}
              {(!hideTime && timeStr || d.duration || (item.cost && !isFullyPaid(item)) || d.booking_ref) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap items-baseline">
                  {!hideTime && timeStr && <span>{timeStr}</span>}
                  {d.duration    && <span>⏱ {d.duration}</span>}
                  {item.cost && !isFullyPaid(item) && <CostDisplay item={item} compact />}
                  {d.booking_ref && <span>Ref: {d.booking_ref}</span>}
                </div>
              )}
              <ClosedChip item={item} />
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function TransferCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showEdit, setShowEdit] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const hideTime = useHideTime()
  const d = item.details ?? {}
  const route = [d.start_location, d.end_location].filter(Boolean).join(' → ')


  const routePts = d.route_points?.length >= 2 ? d.route_points : [d.start_location, d.end_location].filter(Boolean)
  const embedUrl = routePts.length ? buildMapsUrl(routePts, 'd', true) : null
  const mapsLink = d.maps_url || (routePts.length ? buildMapsUrl(routePts, 'd', false) : null)

  return (
    <>
      <div
        style={{
          background: 'color-mix(in srgb, var(--kind-transfer) 6%, var(--surface-2))',
          border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-transfer)`, boxShadow: 'var(--card-shadow)',
          borderRadius: '0.5rem',
          overflow: 'hidden',
        }}
      >
        <div className="relative group">
          <button
            onClick={() => setShowDetail(true)}
            className="w-full text-left hover:opacity-80 transition-opacity"
            style={{ padding: '0.75rem' }}
          >
            <div className="flex items-start gap-2.5">
              <CardIcon item={item} color="var(--kind-transfer)" setItem={setItem} onItemSaved={onItemSaved} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-sm truncate">{item.name}</span>
                  {d.vehicle_type && (
                    <span style={{ color: 'var(--kind-transfer)' }} className="text-xs shrink-0 opacity-80 capitalize">{d.vehicle_type}</span>
                  )}
                </div>
                {route && (
                  <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">{route}</div>
                )}
                {(item.cost || d.distance || d.duration || d.provider || d.booking_ref) && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap items-baseline">
                    {d.distance   && <span>↔ {d.distance}</span>}
                    {d.duration   && <span>⏱ {d.duration}</span>}
                    {item.cost && !isFullyPaid(item) && <CostDisplay item={item} compact />}
                    {d.provider   && <span>via {d.provider}</span>}
                    {d.booking_ref && <span>Ref: {d.booking_ref}</span>}
                  </div>
                )}
                {!hideTime && item.scheduled_at && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs">
                    {fmtDayTime(item.scheduled_at)}
                  </div>
                )}
              </div>
            </div>
          </button>
          <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
        </div>

        {embedUrl && (
          <div
            className="flex items-center gap-3 px-3 py-1.5"
            style={{ borderTop: '1px solid color-mix(in srgb, var(--kind-transfer) 20%, transparent)' }}
          >
            <button
              onClick={() => setShowMap(m => !m)}
              style={{ color: 'var(--kind-transfer)' }}
              className="text-xs hover:opacity-70 transition-opacity"
            >
              {showMap ? '▲ Hide map' : '▼ Show map'}
            </button>
            {mapsLink && (
              <a
                href={mapsLink}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--text-faint)' }}
                className="text-xs hover:opacity-70 transition-opacity ml-auto"
              >
                Open in Maps ↗
              </a>
            )}
          </div>
        )}

        {showMap && embedUrl && (
          <iframe
            src={embedUrl}
            title="Transfer route map"
            width="100%"
            height="280"
            style={{ border: 'none', display: 'block' }}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        )}
      </div>

      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}


function placeSearchUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`
}

function RiverTransferCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showEdit, setShowEdit] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [mapUrl, setMapUrl] = useState(null)
  const d = item.details ?? {}
  const route = [d.start_location, d.end_location].filter(Boolean).join(' → ')
  const hasPath = d.river_path?.length >= 2

  useEffect(() => {
    if (!showMap || !hasPath) return
    let objectUrl = null
    let cancelled = false
    fetchRiverMapBlob(item.id).then(blob => {
      if (cancelled || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setMapUrl(objectUrl)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setMapUrl(null)
    }
  }, [showMap, hasPath, item.id])

  return (
    <>
      <div
        style={{
          background: 'color-mix(in srgb, var(--kind-river_transfer) 6%, var(--surface-2))',
          border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-river_transfer)`, boxShadow: 'var(--card-shadow)',
          borderRadius: '0.5rem',
          overflow: 'hidden',
        }}
      >
        <div className="relative group">
          <button
            onClick={() => setShowDetail(true)}
            className="w-full text-left hover:opacity-80 transition-opacity"
            style={{ padding: '0.75rem' }}
          >
            <div className="flex items-start gap-2.5">
              <CardIcon item={item} color="var(--kind-river_transfer)" setItem={setItem} onItemSaved={onItemSaved} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-sm truncate">{item.name}</span>
                  {d.vehicle_type && (
                    <span style={{ color: 'var(--kind-river_transfer)' }} className="text-xs shrink-0 opacity-80 capitalize">{d.vehicle_type}</span>
                  )}
                </div>
                {route && (
                  <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">{route}</div>
                )}
                {(d.depart_time || d.arrive_time) && (
                  <div style={{ color: 'var(--text-muted)' }} className="text-xs">
                    {[d.depart_time && fmtDateTime(d.depart_time),
                      d.arrive_time && fmtDateTime(d.arrive_time)]
                      .filter(Boolean).join(' → ')}
                    {d.duration && <span style={{ color: 'var(--text-faint)' }}> · {d.duration}</span>}
                  </div>
                )}
                {(item.cost || d.distance || d.provider || d.booking_ref) && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap items-baseline">
                    {d.distance   && <span>↔ {d.distance}</span>}
                    {item.cost && !isFullyPaid(item) && <CostDisplay item={item} compact />}
                    {d.provider   && <span>via {d.provider}</span>}
                    {d.booking_ref && <span>Ref: {d.booking_ref}</span>}
                  </div>
                )}
              </div>
            </div>
          </button>
          <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
        </div>

        {hasPath && (
          <div
            className="flex items-center gap-3 px-3 py-1.5"
            style={{ borderTop: '1px solid color-mix(in srgb, var(--kind-river_transfer) 20%, transparent)' }}
          >
            <button
              onClick={() => setShowMap(m => !m)}
              style={{ color: 'var(--kind-river_transfer)' }}
              className="text-xs hover:opacity-70 transition-opacity"
            >
              {showMap ? '▲ Hide map' : '▼ Show map'}
            </button>
            {d.river_path_approximate && (
              <span style={{ color: 'var(--warning)' }} className="text-xs" title="No detected waterway route — this is a straight line between the two points">
                ⚠ approximate
              </span>
            )}
            <div className="flex gap-2 ml-auto">
              {d.start_location && (
                <a href={placeSearchUrl(d.start_location)} target="_blank" rel="noreferrer"
                  style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70 transition-opacity">
                  Start ↗
                </a>
              )}
              {d.end_location && (
                <a href={placeSearchUrl(d.end_location)} target="_blank" rel="noreferrer"
                  style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70 transition-opacity">
                  End ↗
                </a>
              )}
            </div>
          </div>
        )}

        {showMap && hasPath && (
          mapUrl
            ? <img src={mapUrl} alt="Assumed river path"
                style={{ display: 'block', width: '100%', height: '280px', objectFit: 'contain', background: 'transparent' }} />
            : <div style={{ color: 'var(--text-faint)' }} className="text-xs px-3 py-2">Loading map…</div>
        )}
      </div>

      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function CyclingCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const [gpxMapUrl, setGpxMapUrl] = useState(null)
  const d = item.details ?? {}
  const timeStr = fmtDayTime(item.scheduled_at)
  const hideTime = useHideTime()

  const { hasGpxRoute, embedUrl, mapsLink } = routeMapSource(d, 'b')

  useEffect(() => {
    if (!showMap || !hasGpxRoute) return
    let objectUrl = null
    let cancelled = false
    fetchGpxMapBlob(item.id).then(blob => {
      if (cancelled || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setGpxMapUrl(objectUrl)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      setGpxMapUrl(null)
    }
  }, [showMap, hasGpxRoute, item.id])

  return (
    <>
      <div
        style={{
          background: 'color-mix(in srgb, var(--kind-cycling) 6%, var(--surface-2))',
          border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-cycling)`, boxShadow: 'var(--card-shadow)',
          borderRadius: '0.5rem',
          overflow: 'hidden',
        }}
      >
        <div className="relative group">
          <button
            onClick={() => setShowDetail(true)}
            className="w-full text-left hover:opacity-80 transition-opacity"
            style={{ padding: '0.75rem' }}
          >
            <div className="flex items-start gap-2.5">
              <CardIcon item={item} color="var(--kind-cycling)" setItem={setItem} onItemSaved={onItemSaved} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="font-medium text-sm truncate">{item.name}</div>
                {(d.start_location || d.end_location) && (
                  <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">
                    {[d.start_location, d.end_location].filter(Boolean).join(' → ')}
                  </div>
                )}
                {item.cost && !isFullyPaid(item) && (
                  <div className="text-xs"><CostDisplay item={item} compact /></div>
                )}
                {(!hideTime && timeStr || d.distance || d.elevation_gain || d.elevation_loss || d.surface_type) && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                    {!hideTime && timeStr && <span style={{ color: 'var(--text-muted)' }}>{timeStr}</span>}
                    {d.distance       && <span>{d.distance}</span>}
                    {d.elevation_gain && <span>↑ {d.elevation_gain}</span>}
                    {d.elevation_loss && <span>↓ {d.elevation_loss}</span>}
                    {d.surface_type   && <span className="capitalize">{d.surface_type}</span>}
                  </div>
                )}
              </div>
            </div>
          </button>
          <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
        </div>

        {/* Map controls — only when we have location or GPX-track data */}
        {(embedUrl || hasGpxRoute) && (
          <div
            className="flex items-center gap-3 px-3 py-1.5"
            style={{ borderTop: '1px solid color-mix(in srgb, var(--kind-cycling) 20%, transparent)' }}
          >
            <button
              onClick={() => setShowMap(m => !m)}
              style={{ color: 'var(--kind-cycling)' }}
              className="text-xs hover:opacity-70 transition-opacity"
            >
              {showMap ? '▲ Hide map' : '▼ Show map'}
            </button>
            {mapsLink && (
              <a
                href={mapsLink}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--text-faint)' }}
                className="text-xs hover:opacity-70 transition-opacity ml-auto"
              >
                Open in Maps ↗
              </a>
            )}
          </div>
        )}

        {/* Traced GPX track (the literal recorded/generated path) when available */}
        {showMap && hasGpxRoute && (
          gpxMapUrl
            ? <img src={gpxMapUrl} alt="Recorded route"
                style={{ display: 'block', width: '100%', height: '280px', objectFit: 'contain', background: 'transparent' }} />
            : <div style={{ color: 'var(--text-faint)' }} className="text-xs px-3 py-2">Loading map…</div>
        )}

        {/* Embedded Directions map — fallback when no GPX track is stored */}
        {showMap && embedUrl && (
          <iframe
            src={embedUrl}
            title="Route map"
            width="100%"
            height="280"
            style={{ border: 'none', display: 'block' }}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        )}
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}


function HireCard({ item: initial, onItemSaved, onItemDeleted, hideTime }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}
  const timeStr = item.scheduled_at ? fmtDayTime(item.scheduled_at) : (d.pickup_time ? fmtDayTime(d.pickup_time) : null)

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-hire) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-hire)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-hire)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-medium text-sm truncate">{item.name}</div>
              {(d.provider || d.vehicle_type) && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs capitalize">
                  {[d.vehicle_type, d.provider].filter(Boolean).join(' · ')}
                </div>
              )}
              {d.pickup_location && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs truncate">
                  {[d.pickup_location, d.dropoff_location && d.dropoff_location !== d.pickup_location && d.dropoff_location].filter(Boolean).join(' → ')}
                </div>
              )}
              <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                {!hideTime && timeStr && <span style={{ color: 'var(--text-muted)' }}>{timeStr}</span>}
                {item.cost && !isFullyPaid(item) && <CostDisplay item={item} compact />}
              </div>
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function PurchaseCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}

  return (
    <>
      <div className="relative group">
        <div
          style={{
            background: 'color-mix(in srgb, var(--kind-purchase) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-purchase)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-purchase)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-medium text-sm truncate">{item.name}</div>
              {d.location && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">{d.location}</div>
              )}
              {item.cost && !isFullyPaid(item) && (
                <div className="text-xs"><CostDisplay item={item} compact /></div>
              )}
              {d.description && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs"><RichText>{d.description}</RichText></div>
              )}
              {item.link && (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--kind-purchase)' }}
                  className="text-xs opacity-80 hover:opacity-60 transition-opacity"
                >
                  {(() => { try { return new URL(item.link).hostname } catch { return item.link } })()} ↗
                </a>
              )}
            </div>
          </div>
        </div>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function FoodCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}

  return (
    <>
      <div className="relative group">
        <div
          className="w-full text-left"
          style={{
            background: 'color-mix(in srgb, var(--kind-food) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-food)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-food)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm truncate">{item.name}</span>
                {item.link && (
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    style={{ color: 'var(--kind-food)' }}
                    className="text-xs shrink-0 opacity-80 hover:opacity-60 transition-opacity"
                  >
                    ↗
                  </a>
                )}
              </div>
              {d.description && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs"><RichText>{d.description}</RichText></div>
              )}
            </div>
          </div>
        </div>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function ActivityCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}
  const timeStr = fmtDayTime(item.scheduled_at)
  const hideTime = useHideTime()

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-activity) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-activity)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-activity)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-medium text-sm">{item.name}</div>
              {d.location && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">📍 {d.location}</div>
              )}
              {d.description && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs"><RichText>{d.description}</RichText></div>
              )}
              {item.notes && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs"><RichText>{item.notes}</RichText></div>
              )}
              {(!hideTime && timeStr || d.duration || (item.cost && !isFullyPaid(item))) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap items-baseline">
                  {!hideTime && timeStr && <span>{timeStr}</span>}
                  {d.duration && <span>⏱ {d.duration}</span>}
                  {item.cost && !isFullyPaid(item) && <CostDisplay item={item} compact />}
                </div>
              )}
              <ClosedChip item={item} />
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && (
        <ItemDetailModal
          item={item}
          onClose={() => setShowDetail(false)}
          onEdit={() => { setShowDetail(false); setShowEdit(true) }}
          onDeleted={onItemDeleted}
          onSave={updated => { setItem(updated); onItemSaved?.(updated) }}
        />
      )}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function ShowCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}
  const timeStr = fmtDayTime(item.scheduled_at)
  const hideTime = useHideTime()

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-show) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-show)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-show)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-medium text-sm">{item.name}</div>
              {d.location && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">📍 {d.location}</div>
              )}
              {d.description && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs"><RichText>{d.description}</RichText></div>
              )}
              {(d.seats || d.tickets) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                  {d.seats && <span>🎫 {d.seats}</span>}
                  {d.tickets && <span>{d.tickets}</span>}
                </div>
              )}
              {item.notes && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs"><RichText>{item.notes}</RichText></div>
              )}
              {(!hideTime && timeStr || d.duration || (item.cost && !isFullyPaid(item))) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap items-baseline">
                  {!hideTime && timeStr && <span>{timeStr}</span>}
                  {d.duration && <span>⏱ {d.duration}</span>}
                  {item.cost && !isFullyPaid(item) && <CostDisplay item={item} compact />}
                </div>
              )}
              <ClosedChip item={item} />
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && (
        <ItemDetailModal
          item={item}
          onClose={() => setShowDetail(false)}
          onEdit={() => { setShowDetail(false); setShowEdit(true) }}
          onDeleted={onItemDeleted}
          onSave={updated => { setItem(updated); onItemSaved?.(updated) }}
        />
      )}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

function NoteCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

  const timeStr = fmtDayTime(item.scheduled_at)
  const hideTime = useHideTime()
  const important = !!item.details?.important
  const extraNote = item.notes && item.notes.trim() !== item.name?.trim() ? item.notes.trim() : ''

  return (
    <>
      <div className="relative group">
        {important ? (
          <button
            onClick={() => setShowDetail(true)}
            className="w-full text-left hover:opacity-80 transition-opacity"
            style={{
              background: 'color-mix(in srgb, var(--warning) 14%, var(--surface-2))',
              border: '1px solid var(--border)', borderLeft: '3px solid var(--warning)', boxShadow: 'var(--card-shadow)',
              borderRadius: '0.5rem',
              padding: '0.6rem 0.75rem',
            }}
          >
            <div className="flex items-center gap-2.5">
              <CardIcon item={item} color="var(--warning)" setItem={setItem} onItemSaved={onItemSaved} />
              <div className="flex-1 min-w-0 text-sm">
                <span style={{ color: 'var(--text)' }} className="font-semibold">{item.name}</span>
                {extraNote && <span style={{ color: 'var(--text-muted)' }}>: {extraNote}</span>}
              </div>
            </div>
          </button>
        ) : (
          <button
            onClick={() => setShowDetail(true)}
            className="w-full text-left hover:opacity-80 transition-opacity"
            style={{
              background: 'color-mix(in srgb, var(--kind-note) 6%, var(--surface-2))',
              border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-note)`, boxShadow: 'var(--card-shadow)',
              borderRadius: '0.5rem',
              padding: '0.75rem',
            }}
          >
            <div className="flex items-start gap-2.5">
              <CardIcon item={item} color="var(--kind-note)" setItem={setItem} onItemSaved={onItemSaved} />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="font-medium text-sm">{item.name}</div>
                {extraNote && (
                  <div style={{ color: 'var(--text-muted)' }} className="text-xs"><RichText>{extraNote}</RichText></div>
                )}
                {(!hideTime && timeStr || (item.cost && !isFullyPaid(item))) && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap items-baseline">
                    {!hideTime && timeStr && <span>{timeStr}</span>}
                    {item.cost && !isFullyPaid(item) && <CostDisplay item={item} compact />}
                  </div>
                )}
              </div>
            </div>
          </button>
        )}
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && (
        <ItemDetailModal
          item={item}
          onClose={() => setShowDetail(false)}
          onEdit={() => { setShowDetail(false); setShowEdit(true) }}
          onDeleted={onItemDeleted}
          onSave={updated => { setItem(updated); onItemSaved?.(updated) }}
        />
      )}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}

const BOOKING_STATUS_COLOR = { planned: 'var(--text-faint)', booked: 'var(--kind-activity)', confirmed: 'var(--success)' }

function RestaurantCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const hideTime = useHideTime()
  const d = item.details ?? {}

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-restaurant) 6%, var(--surface-2))',
            border: '1px solid var(--border)', borderLeft: `3px solid var(--kind-restaurant)`, boxShadow: 'var(--card-shadow)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} color="var(--kind-restaurant)" setItem={setItem} onItemSaved={onItemSaved} />
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm truncate">{item.name}</span>
                {d.booking_status && (
                  <span style={{ color: BOOKING_STATUS_COLOR[d.booking_status] ?? 'var(--text-faint)', fontSize: '0.65rem' }} className="capitalize shrink-0 font-medium">
                    {d.booking_status}
                  </span>
                )}
              </div>
              {d.location && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">{d.location}</div>
              )}
              {item.cost && !isFullyPaid(item) && (
                <div className="text-xs"><CostDisplay item={item} compact /></div>
              )}
              {(!hideTime && (item.scheduled_at || d.reservation_time) || item.notes || d.booking_ref) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                  {!hideTime && (item.scheduled_at
                    ? <span key="when">{fmtDayTime(item.scheduled_at)}</span>
                    : d.reservation_time ? <span key="when">{d.reservation_time}</span> : null)}
                  {item.notes && <span>{item.notes}</span>}
                  {d.booking_ref && <span>Ref: {d.booking_ref}</span>}
                </div>
              )}
              <ClosedChip item={item} />
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}
