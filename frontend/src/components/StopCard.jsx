import { useState } from 'react'
import { updateStopStatus } from '../api.js'
import ItemRow from './ItemRow.jsx'
import FlightDetailModal from './FlightDetailModal.jsx'
import ItemDetailModal from './ItemDetailModal.jsx'
import ItemEditModal from './ItemEditModal.jsx'
import { countryFlag } from '../countryFlag.js'
import { airportName } from '../airportNames.js'
import RailDetailModal from './RailDetailModal.jsx'

const STATUS_CYCLE = { planned: 'confirmed', confirmed: 'completed', completed: 'planned', cancelled: 'planned' }

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function fmtDateTime(val) {
  if (!val) return null
  const [datePart, timePart] = val.split('T')
  const dateStr = new Date(datePart + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return timePart ? `${dateStr} ${timePart}` : dateStr
}

export default function StopCard({ stop, index, onUpdate }) {
  const [open, setOpen] = useState(index === 0)
  const [status, setStatus] = useState(stop.status)
  const [busy, setBusy] = useState(false)

  const accom = stop.items.find(i => i.kind === 'accommodation')

  const sortKey = item => {
    const dt = (item.kind === 'flight' || item.kind === 'rail') ? item.details?.depart_time : item.scheduled_at
    return dt ? new Date(dt).getTime() : Infinity
  }
  const timeline = stop.items
    .filter(i => i.kind !== 'accommodation')
    .sort((a, b) => sortKey(a) - sortKey(b))

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

  return (
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
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm flex items-center gap-1.5">
            {flag && <span className="text-base leading-none">{flag}</span>}
            <span className="truncate">{stop.location}</span>
          </div>
          {(stop.arrive || stop.depart) && (
            <div style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5">
              {fmtDate(stop.arrive)}{stop.depart ? ` → ${fmtDate(stop.depart)}` : ''}
            </div>
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
          {accom && (
            <Section label="Accommodation">
              <AccomCard item={accom} />
            </Section>
          )}

          {timeline.length > 0 && (
            <div className="space-y-1">
              {timeline.map(item => {
                if (item.kind === 'flight')    return <FlightCard    key={item.id} item={item} />
                if (item.kind === 'rail')      return <RailCard      key={item.id} item={item} />
                if (item.kind === 'restaurant') return <RestaurantCard key={item.id} item={item} />
                if (item.kind === 'cycling')   return <CyclingCard   key={item.id} item={item} />
                if (item.kind === 'walk')      return <WalkCard      key={item.id} item={item} />
                if (item.kind === 'transfer')  return <TransferCard  key={item.id} item={item} />
                return <ItemRow key={item.id} item={item} />
              })}
            </div>
          )}

          {!accom && timeline.length === 0 && (
            <p style={{ color: 'var(--text-faint)' }} className="text-xs">No details recorded.</p>
          )}
        </div>
      )}
    </div>
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

function FlightCard({ item: initial }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}
  const route = [d.origin, d.destination].filter(Boolean).map(airportName).join(' → ')

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
            <span style={{ color: 'var(--kind-flight)', fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>✈</span>
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm">{route || item.name}</span>
                <span style={{ color: 'var(--kind-flight)' }} className="text-xs shrink-0 opacity-80">
                  {[d.flight_number, d.airline].filter(Boolean).join(' · ')}
                </span>
              </div>
              {(d.depart_time || d.arrive_time) && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs">
                  {[d.depart_time && fmtDateTime(d.depart_time) + (d.depart_tz ? ` ${d.depart_tz}` : ''),
                    d.arrive_time && fmtDateTime(d.arrive_time) + (d.arrive_tz ? ` ${d.arrive_tz}` : '')]
                    .filter(Boolean).join(' → ')}
                  {d.duration && <span style={{ color: 'var(--text-faint)' }}> · {d.duration}</span>}
                </div>
              )}
              {(d.origin_terminal || d.origin_gate || d.arrive_terminal || d.arrive_gate || d.checkin_desk) && (
                <div style={{ color: 'var(--kind-flight)' }} className="text-xs flex gap-3 opacity-80 flex-wrap">
                  {(d.origin_terminal || d.origin_gate) && (
                    <span>Dep{d.origin_terminal ? ` T${d.origin_terminal}` : ''}{d.origin_gate ? ` Gate ${d.origin_gate}` : ''}</span>
                  )}
                  {d.checkin_desk && <span>Check-in {d.checkin_desk}</span>}
                  {(d.arrive_terminal || d.arrive_gate) && (
                    <span>Arr{d.arrive_terminal ? ` T${d.arrive_terminal}` : ''}{d.arrive_gate ? ` Gate ${d.arrive_gate}` : ''}</span>
                  )}
                </div>
              )}
              {(d.fare_class || d.seats) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3">
                  {d.fare_class && <span>{d.fare_class}</span>}
                  {d.seats && <span>Seats: {d.seats}</span>}
                </div>
              )}
            </div>
          </div>
        </button>
        <button
          onClick={e => { e.stopPropagation(); setShowEdit(true) }}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
          title="Edit"
        >
          ✎
        </button>
      </div>
      {showDetail && <FlightDetailModal item={item} onClose={() => setShowDetail(false)} onSave={updated => setItem(updated)} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}

function RailCard({ item: initial }) {
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
            <span style={{ color: 'var(--kind-rail)', fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>🚄</span>
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm">{route || item.name}</span>
                <span style={{ color: 'var(--kind-rail)' }} className="text-xs shrink-0 opacity-80">
                  {[d.train_number, d.operator].filter(Boolean).join(' · ')}
                </span>
              </div>
              {(d.depart_time || d.arrive_time) && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs">
                  {[d.depart_time && fmtDateTime(d.depart_time),
                    d.arrive_time && fmtDateTime(d.arrive_time)]
                    .filter(Boolean).join(' → ')}
                  {d.duration && <span style={{ color: 'var(--text-faint)' }}> · {d.duration}</span>}
                </div>
              )}
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
            </div>
          </div>
        </button>
        <button
          onClick={e => { e.stopPropagation(); setShowEdit(true) }}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
          title="Edit"
        >✎</button>
      </div>
      {showDetail && <RailDetailModal item={item} onClose={() => setShowDetail(false)} onSave={updated => setItem(updated)} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}

function AccomCard({ item: initial }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
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
            <span style={{ color: 'var(--kind-accommodation)', fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>🛏</span>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-medium text-sm">{item.name}</div>
              {d.location && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs">{d.location}</div>
              )}
              {(d.checkin || d.checkout) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs">
                  {[d.checkin && `In: ${fmtDateTime(d.checkin)}`,
                    d.checkout && `Out: ${fmtDateTime(d.checkout)}`]
                    .filter(Boolean).join('  ·  ')}
                </div>
              )}
              {(d.booking_ref || item.cost) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3">
                  {d.booking_ref && <span>Ref: {d.booking_ref}</span>}
                  {item.cost && <span>{item.cost}</span>}
                </div>
              )}
            </div>
          </div>
        </button>
        <button
          onClick={e => { e.stopPropagation(); setShowEdit(true) }}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
          title="Edit"
        >
          ✎
        </button>
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}

function WalkCard({ item: initial }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const d = item.details ?? {}
  const route = [d.start_location, d.end_location].filter(Boolean).join(' → ')

  // Build a Google Maps embed URL from stored start/end locations (walking mode)
  const embedUrl = d.start_location
    ? 'https://maps.google.com/maps?' + new URLSearchParams(
        d.end_location
          ? { saddr: d.start_location, daddr: d.end_location, dirflg: 'w' }
          : { q: d.start_location }
      ).toString() + '&output=embed'
    : null

  // Link for "Open in Maps" — prefer the stored original URL
  const mapsLink = d.maps_url || (d.start_location
    ? 'https://maps.google.com/maps?' + new URLSearchParams(
        d.end_location
          ? { saddr: d.start_location, daddr: d.end_location, dirflg: 'w' }
          : { q: d.start_location }
      ).toString()
    : null)

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
              <span style={{ color: 'var(--kind-walk)', fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>🥾</span>
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-sm truncate">{item.name}</span>
                  {d.difficulty && (
                    <span style={{ color: 'var(--kind-walk)' }} className="text-xs shrink-0 opacity-80 capitalize">{d.difficulty}</span>
                  )}
                </div>
                {route && (
                  <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">{route}</div>
                )}
                {(d.distance || d.elevation_gain || d.elevation_loss || d.duration) && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                    {d.distance       && <span>↔ {d.distance}</span>}
                    {d.elevation_gain && <span>↑ {d.elevation_gain}</span>}
                    {d.elevation_loss && <span>↓ {d.elevation_loss}</span>}
                    {d.duration       && <span>⏱ {d.duration}</span>}
                  </div>
                )}
              </div>
            </div>
          </button>
          <button
            onClick={e => { e.stopPropagation(); setShowEdit(true) }}
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
            title="Edit"
          >✎</button>
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

      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}

function TransferCard({ item: initial }) {
  const [item, setItem] = useState(initial)
  const [showEdit, setShowEdit] = useState(false)
  const [showMap, setShowMap] = useState(false)
  const d = item.details ?? {}
  const route = [d.start_location, d.end_location].filter(Boolean).join(' → ')

  const vehicleIcon = { bus: '🚌', minibus: '🚌', shuttle: '🚌', taxi: '🚕' }[d.vehicle_type] ?? '🚗'

  const embedUrl = d.start_location
    ? 'https://maps.google.com/maps?' + new URLSearchParams(
        d.end_location
          ? { saddr: d.start_location, daddr: d.end_location, dirflg: 'd' }
          : { q: d.start_location }
      ).toString() + '&output=embed'
    : null

  const mapsLink = d.maps_url || (d.start_location
    ? 'https://maps.google.com/maps?' + new URLSearchParams(
        d.end_location
          ? { saddr: d.start_location, daddr: d.end_location, dirflg: 'd' }
          : { q: d.start_location }
      ).toString()
    : null)

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
            onClick={() => setShowEdit(true)}
            className="w-full text-left hover:opacity-80 transition-opacity"
            style={{ padding: '0.75rem' }}
          >
            <div className="flex items-start gap-2.5">
              <span style={{ color: 'var(--kind-transfer)', fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>{vehicleIcon}</span>
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
                {(d.distance || d.duration || item.cost || d.provider || d.booking_ref) && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                    {d.distance   && <span>↔ {d.distance}</span>}
                    {d.duration   && <span>⏱ {d.duration}</span>}
                    {item.cost    && <span>💳 {item.cost}</span>}
                    {d.provider   && <span>via {d.provider}</span>}
                    {d.booking_ref && <span>Ref: {d.booking_ref}</span>}
                  </div>
                )}
              </div>
            </div>
          </button>
          <button
            onClick={e => { e.stopPropagation(); setShowEdit(true) }}
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
            style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
            title="Edit"
          >✎</button>
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

      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}

function CyclingCard({ item: initial }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const d = item.details ?? {}

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
            <span style={{ color: 'var(--kind-cycling)', fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>🚴</span>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-medium text-sm truncate">{item.name}</div>
              {(d.start_location || d.end_location) && (
                <div style={{ color: 'var(--text-muted)' }} className="text-xs truncate">
                  {[d.start_location, d.end_location].filter(Boolean).join(' → ')}
                </div>
              )}
              {(d.distance || d.elevation_gain || d.elevation_loss || d.surface_type) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                  {d.distance       && <span>{d.distance}</span>}
                  {d.elevation_gain && <span>↑ {d.elevation_gain}</span>}
                  {d.elevation_loss && <span>↓ {d.elevation_loss}</span>}
                  {d.surface_type   && <span className="capitalize">{d.surface_type}</span>}
                </div>
              )}
            </div>
          </div>
        </button>
        <button
          onClick={e => { e.stopPropagation(); setShowEdit(true) }}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
          title="Edit"
        >✎</button>
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}

const BOOKING_STATUS_COLOR = { planned: 'var(--text-faint)', booked: 'var(--kind-activity)', confirmed: 'var(--success)' }

function RestaurantCard({ item: initial }) {
  const [item, setItem] = useState(initial)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
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
            <span style={{ color: 'var(--kind-restaurant)', fontSize: '0.9rem', lineHeight: 1.4, flexShrink: 0 }}>🍽</span>
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
              {(item.scheduled_at || d.reservation_time || item.notes || d.booking_ref || item.cost) && (
                <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3 flex-wrap">
                  {(() => {
                    if (item.scheduled_at) {
                      const [dp, tp] = item.scheduled_at.split('T')
                      const date = new Date(dp + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
                      const t = tp?.slice(0, 5)
                      return <span key="when">{t && t !== '00:00' ? `${date} · ${t}` : date}</span>
                    }
                    if (d.reservation_time) return <span key="when">{d.reservation_time}</span>
                    return null
                  })()}
                  {item.notes && <span>{item.notes}</span>}
                  {d.booking_ref && <span>Ref: {d.booking_ref}</span>}
                  {item.cost && <span>{item.cost}</span>}
                </div>
              )}
            </div>
          </div>
        </button>
        <button
          onClick={e => { e.stopPropagation(); setShowEdit(true) }}
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
          title="Edit"
        >
          ✎
        </button>
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} />}
      {showEdit && (
        <ItemEditModal
          item={item}
          onSave={updated => { setItem(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}
