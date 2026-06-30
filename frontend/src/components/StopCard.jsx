import { useState, useEffect, createContext, useContext } from 'react'
import { updateStopStatus, updateItemStatus, getWeather } from '../api.js'
import { useHideCompleted, useShowInbound, useKindFilter } from '../settings.js'
import { parseCheckinWindow, calcCheckinTime } from '../checkin.js'
import { fmtDay, fmtDayTime } from '../dates.js'
import { useCanEdit } from '../roles.js'
import ItemRow from './ItemRow.jsx'
import FlightDetailModal from './FlightDetailModal.jsx'
import ItemDetailModal from './ItemDetailModal.jsx'
import ItemEditModal, { buildMapsUrl } from './ItemEditModal.jsx'
import CostDisplay from './CostDisplay.jsx'
import RichText from './RichText.jsx'
import { isFullyPaid } from '../currency.js'
import { countryFlag } from '../countryFlag.js'
import { airportName } from '../airportNames.js'
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
  if (item.kind === 'flight' || item.kind === 'rail') dt = item.details?.depart_time
  else if (item.kind === 'accommodation') dt = item.details?.checkin || item.scheduled_at
  else dt = item.scheduled_at
  if (!dt) return null
  return String(dt).split('T')[0]
}

export function itemTimeStr(item) {
  let dt
  if (item.kind === 'flight' || item.kind === 'rail') dt = item.details?.depart_time
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
  if (item.kind === 'flight' || item.kind === 'rail') return item.details?.depart_tz || ''
  return ''
}

function fmtDayHeader(dateKey) {
  const d = new Date(dateKey + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function DayBanner({ dateKey, weather }) {
  return (
    <div
      style={{ background: 'var(--surface-2)', borderRadius: '0.375rem' }}
      className="px-3 py-1.5 text-xs font-semibold flex items-center"
    >
      <span>{fmtDayHeader(dateKey)}</span>
      {weather && (
        <span style={{ color: 'var(--text-faint)' }} className="ml-2 font-normal" title={weather.desc}>
          {weather.icon} {Math.round(weather.tmin)}–{Math.round(weather.tmax)}°
        </span>
      )}
    </div>
  )
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
const TRANSPORT_KINDS = new Set(['flight', 'rail', 'transfer'])

function _arriveStr(item) {
  const d = item.details || {}
  return (item.kind === 'flight' || item.kind === 'rail') ? (d.arrive_time || null) : null
}

function _departStr(item) {
  const d = item.details || {}
  return (item.kind === 'flight' || item.kind === 'rail') ? (d.depart_time || null) : (item.scheduled_at || null)
}

function _connectionLocation(item) {
  const d = item.details || {}
  if (item.kind === 'flight') { const c = d.destination; return c ? (airportName(c) || c) : null }
  if (item.kind === 'rail')     return d.destination || null
  if (item.kind === 'transfer') return d.end_location || null
  return null
}

export function fmtConnectionDur(ms) {
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60), m = mins % 60
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
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
  if (item.kind === 'flight' || item.kind === 'rail')
    return toUtcMs(d.depart_time, d.depart_tz)
  if (item.kind === 'accommodation')
    return toUtcMs(d.checkin || item.scheduled_at, null)
  return toUtcMs(item.scheduled_at, null)
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

export default function StopCard({ stop, index, onUpdate, inbound, hideFrame = false, inboundConnection = null, skipDays = null, onItemAdded }) {
  const [open, setOpen] = useState(index === 0)
  const [status, setStatus] = useState(stop.status)
  const [busy, setBusy] = useState(false)
  const [itemEdits, setItemEdits] = useState({})  // Only track local edits, not synced items
  const canEdit = useCanEdit()

  // Use stop.items directly instead of syncing to local state—this ensures fresh data
  const items = stop.items

  // Weather for the day headers: forecast/climatology per the stop's date span.
  const [weather, setWeather] = useState({})
  const _dayKeys = items.map(itemDateKey).filter(Boolean).sort()
  const wxStart = _dayKeys[0] || (stop.arrive ? String(stop.arrive).split('T')[0] : null)
  const wxEnd   = _dayKeys[_dayKeys.length - 1] || (stop.depart ? String(stop.depart).split('T')[0] : null)
  useEffect(() => {
    if (!open || !stop.lat || !stop.lng || !wxStart || !wxEnd) return
    let cancelled = false
    getWeather(stop.lat, stop.lng, wxStart, wxEnd)
      .then(r => { if (!cancelled) setWeather(r.weather || {}) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, stop.lat, stop.lng, wxStart, wxEnd])

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
    .filter(i => i.status !== 'done' || !hideCompleted)
    .filter(i => !kindFilter || i.kind === kindFilter)

  const sortKey = item => {
    const d = item.details || {}
    if (item.kind === 'flight' || item.kind === 'rail')
      return toUtcMs(d.depart_time, d.depart_tz) ?? Infinity
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
  // Important notes are pinned to the very top of the stop; everything else flows
  // chronologically (by check-in / arrival). Food & purchases stay grouped.
  const isImportant = i => i.kind === 'note' && i.details?.important
  const timeline = visibleItems
    .filter(i => i.kind !== 'food' && i.kind !== 'purchase')
    .sort((a, b) => {
      const ia = isImportant(a) ? 0 : 1, ib = isImportant(b) ? 0 : 1
      if (ia !== ib) return ia - ib
      return sortKey(a) - sortKey(b)
    })
  const foodItems = visibleItems.filter(i => i.kind === 'food')
  const purchaseItems = visibleItems.filter(i => i.kind === 'purchase')

  const checkoutAccom = items.find(i => i.kind === 'accommodation' && i.details?.checkout)

  const flag = countryFlag(stop.country)

  async function cycleStatus(e) {
    e.stopPropagation()
    if (busy) return
    const next = STATUS_CYCLE[status]
    setStatus(next); setBusy(true)
    try { await updateStopStatus(stop.id, next); onUpdate() }
    catch { setStatus(status) }
    finally { setBusy(false) }
  }

  if (hideFrame) {
    return (
      <>
      <div className="space-y-2">
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
            const props = { key: item.id, item, onItemSaved: handleItemSaved, onItemDeleted: handleItemDeleted }
            if (item.kind === 'accommodation') return <AccomCard {...props} />
            if (item.kind === 'flight')        return <FlightCard {...props} />
            if (item.kind === 'rail')          return <RailCard {...props} />
            if (item.kind === 'restaurant')    return <RestaurantCard {...props} />
            if (item.kind === 'cycling')       return <CyclingCard {...props} />
            if (item.kind === 'walk')          return <WalkCard {...props} />
            if (item.kind === 'transfer')      return <TransferCard {...props} />
            if (item.kind === 'tour')          return <TourCard {...props} />
            if (item.kind === 'note')          return <NoteCard {...props} />
            if (item.kind === 'activity')      return <ActivityCard {...props} />
            if (item.kind === 'show')          return <ShowCard {...props} />
            if (item.kind === 'hire')          return <HireCard {...props} />
            return <ItemRow {...props} />
          }
          return (
            <>
              {sortedDates.map(dk => {
                const showBanner = !skipDays?.has(dk)
                return (
                  <div key={dk} className="space-y-1">
                    {showBanner && <DayBanner dateKey={dk} weather={weather[dk]} />}
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
        className="w-full px-4 py-3.5 flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          {flag && <span className="text-base leading-none shrink-0">{flag}</span>}
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
        <span style={{ color: 'var(--text-faint)', fontSize: '0.6rem' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)' }} className="px-4 py-4 space-y-4">
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
              const props = { key: item.id, item, onItemSaved: handleItemSaved, onItemDeleted: handleItemDeleted }
              if (item.kind === 'accommodation') return <AccomCard {...props} />
              if (item.kind === 'flight')        return <FlightCard {...props} />
              if (item.kind === 'rail')          return <RailCard {...props} />
              if (item.kind === 'restaurant')    return <RestaurantCard {...props} />
              if (item.kind === 'cycling')       return <CyclingCard {...props} />
              if (item.kind === 'walk')          return <WalkCard {...props} />
              if (item.kind === 'transfer')      return <TransferCard {...props} />
              if (item.kind === 'tour')          return <TourCard {...props} />
              if (item.kind === 'note')          return <NoteCard {...props} />
              if (item.kind === 'activity')      return <ActivityCard {...props} />
              if (item.kind === 'show')          return <ShowCard {...props} />
              if (item.kind === 'hire')          return <HireCard {...props} />
              return <ItemRow {...props} />
            }
            return (
              <div className="space-y-2">
                {sortedDates.map(dk => (
                  <div key={dk} className="space-y-1">
                    <DayBanner dateKey={dk} weather={weather[dk]} />
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
              <span style={{ color: 'var(--kind-accommodation)' }}>🛏</span>
              <span style={{ color: 'var(--kind-accommodation)' }} className="font-medium">Check out</span>
              <span style={{ color: 'var(--text)' }} className="truncate">{checkoutAccom.name}</span>
              <span style={{ color: 'var(--text-faint)' }} className="ml-auto shrink-0">{fmtDayTime(checkoutAccom.details.checkout)}</span>
            </div>
          )}
        </div>
      )}

    </div>

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
function CardIcon({ item, icon, color, setItem, onItemSaved }) {
  const canEdit = useCanEdit()
  const done = item.status === 'done'
  async function toggle(e) {
    e.stopPropagation()
    if (!canEdit) return
    const next = done ? 'pending' : 'done'
    const prev = item
    const updated = { ...item, status: next }
    setItem(updated); onItemSaved?.(updated)
    try { await updateItemStatus(item.id, next) }
    catch { setItem(prev); onItemSaved?.(prev) }
  }
  return (
    <span
      onClick={canEdit ? toggle : undefined}
      title={canEdit ? (done ? 'Mark as not done' : 'Mark as done') : undefined}
      style={{ color: done ? 'var(--success)' : color, fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0, cursor: canEdit ? 'pointer' : 'default' }}
      className={canEdit ? 'hover:opacity-70 transition-opacity' : ''}
    >
      {done ? '✓' : icon}
    </span>
  )
}

// Hover edit pencil — renders nothing for viewers.
function EditPencil({ onClick, absolute = true }) {
  if (!useCanEdit()) return null
  return (
    <button
      onClick={onClick}
      className={`edit-btn ${absolute ? 'absolute top-2 right-2 ' : ''}opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity`}
      style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
      title="Edit"
    >✎</button>
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
  const vehicleIcon = { bus: '🚌', minibus: '🚌', shuttle: '🚌', taxi: '🚕' }[d.vehicle_type] ?? '🚗'
  const icon = isFlight ? '✈' : isRail ? '🚄' : vehicleIcon
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
          <span style={{ color, fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>{icon}</span>
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
            border: '1px solid color-mix(in srgb, var(--kind-flight) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="✈" color="var(--kind-flight)" setItem={setItem} onItemSaved={onItemSaved} />
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
            border: '1px solid color-mix(in srgb, var(--kind-rail) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🚄" color="var(--kind-rail)" setItem={setItem} onItemSaved={onItemSaved} />
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
            border: '1px solid color-mix(in srgb, var(--kind-accommodation) 40%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🛏" color="var(--kind-accommodation)" setItem={setItem} onItemSaved={onItemSaved} />
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
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
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

function WalkCard({ item: initial, onItemSaved, onItemDeleted }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const d = item.details ?? {}
  const route = [d.start_location, d.end_location].filter(Boolean).join(' → ')
  const timeStr = fmtDayTime(item.scheduled_at)
  const hideTime = useHideTime()

  // Full ordered route (incl. intermediate waypoints) when available, else start/end.
  const routePts = d.route_points?.length >= 2 ? d.route_points : [d.start_location, d.end_location].filter(Boolean)
  const embedUrl = routePts.length ? buildMapsUrl(routePts, 'w', true) : null
  // Link for "Open in Maps" — prefer the stored original URL (preserves all waypoints)
  const mapsLink = d.maps_url || (routePts.length ? buildMapsUrl(routePts, 'w', false) : null)

  return (
    <>
      <div
        style={{
          background: 'color-mix(in srgb, var(--kind-walk) 6%, var(--surface-2))',
          border: '1px solid color-mix(in srgb, var(--kind-walk) 35%, transparent)',
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
              <CardIcon item={item} icon="🥾" color="var(--kind-walk)" setItem={setItem} onItemSaved={onItemSaved} />
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

        {/* Map controls — only when we have location data */}
        {embedUrl && (
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

        {/* Embedded map iframe */}
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

      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
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
            border: '1px solid color-mix(in srgb, var(--kind-tour) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🎟️" color="var(--kind-tour)" setItem={setItem} onItemSaved={onItemSaved} />
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
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
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

  const vehicleIcon = { bus: '🚌', minibus: '🚌', shuttle: '🚌', taxi: '🚕' }[d.vehicle_type] ?? '🚗'

  const routePts = d.route_points?.length >= 2 ? d.route_points : [d.start_location, d.end_location].filter(Boolean)
  const embedUrl = routePts.length ? buildMapsUrl(routePts, 'd', true) : null
  const mapsLink = d.maps_url || (routePts.length ? buildMapsUrl(routePts, 'd', false) : null)

  return (
    <>
      <div
        style={{
          background: 'color-mix(in srgb, var(--kind-transfer) 6%, var(--surface-2))',
          border: '1px solid color-mix(in srgb, var(--kind-transfer) 35%, transparent)',
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
              <CardIcon item={item} icon={vehicleIcon} color="var(--kind-transfer)" setItem={setItem} onItemSaved={onItemSaved} />
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

      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
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
            background: 'color-mix(in srgb, var(--kind-cycling) 6%, var(--surface-2))',
            border: '1px solid color-mix(in srgb, var(--kind-cycling) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🚴" color="var(--kind-cycling)" setItem={setItem} onItemSaved={onItemSaved} />
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
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
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

const HIRE_ICON = { car: '🚗', bike: '🚲', scooter: '🛵', van: '🚐', motorcycle: '🏍' }

function HireCard({ item: initial, onItemSaved, onItemDeleted, hideTime }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}
  const icon = HIRE_ICON[(d.vehicle_type || '').toLowerCase()] ?? '🚗'
  const timeStr = item.scheduled_at ? fmtDayTime(item.scheduled_at) : (d.pickup_time ? fmtDayTime(d.pickup_time) : null)

  return (
    <>
      <div className="relative group">
        <button
          onClick={() => setShowDetail(true)}
          className="w-full text-left hover:opacity-80 transition-opacity"
          style={{
            background: 'color-mix(in srgb, var(--kind-hire) 6%, var(--surface-2))',
            border: '1px solid color-mix(in srgb, var(--kind-hire) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon={icon} color="var(--kind-hire)" setItem={setItem} onItemSaved={onItemSaved} />
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
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
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
            border: '1px solid color-mix(in srgb, var(--kind-purchase) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🛍️" color="var(--kind-purchase)" setItem={setItem} onItemSaved={onItemSaved} />
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
            border: '1px solid color-mix(in srgb, var(--kind-food) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🍴" color="var(--kind-food)" setItem={setItem} onItemSaved={onItemSaved} />
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
            border: '1px solid color-mix(in srgb, var(--kind-activity) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="⭐" color="var(--kind-activity)" setItem={setItem} onItemSaved={onItemSaved} />
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
            border: '1px solid color-mix(in srgb, var(--kind-show) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🎭" color="var(--kind-show)" setItem={setItem} onItemSaved={onItemSaved} />
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
              border: '1px solid color-mix(in srgb, var(--warning) 55%, transparent)',
              borderRadius: '0.5rem',
              padding: '0.6rem 0.75rem',
            }}
          >
            <div className="flex items-center gap-2.5">
              <CardIcon item={item} icon="📌" color="var(--warning)" setItem={setItem} onItemSaved={onItemSaved} />
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
              border: '1px solid color-mix(in srgb, var(--kind-note) 35%, transparent)',
              borderRadius: '0.5rem',
              padding: '0.75rem',
            }}
          >
            <div className="flex items-start gap-2.5">
              <CardIcon item={item} icon="📝" color="var(--kind-note)" setItem={setItem} onItemSaved={onItemSaved} />
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
            border: '1px solid color-mix(in srgb, var(--kind-restaurant) 35%, transparent)',
            borderRadius: '0.5rem',
            padding: '0.75rem',
          }}
        >
          <div className="flex items-start gap-2.5">
            <CardIcon item={item} icon="🍽" color="var(--kind-restaurant)" setItem={setItem} onItemSaved={onItemSaved} />
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
            </div>
          </div>
        </button>
        <EditPencil onClick={e => { e.stopPropagation(); setShowEdit(true) }} />
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} onEdit={() => { setShowDetail(false); setShowEdit(true) }} onDeleted={onItemDeleted} />}
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
