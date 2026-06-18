import { useState } from 'react'
import { updateStopStatus } from '../api.js'
import ItemRow from './ItemRow.jsx'
import FlightDetailModal from './FlightDetailModal.jsx'
import ItemDetailModal from './ItemDetailModal.jsx'
import ItemEditModal from './ItemEditModal.jsx'
import { countryFlag } from '../countryFlag.js'

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

  const accom     = stop.items.find(i => i.kind === 'accommodation')
  const flights   = stop.items.filter(i => i.kind === 'flight')
  const activities = stop.items.filter(i => i.kind === 'activity')
  const restaurants = stop.items.filter(i => i.kind === 'restaurant')
  const notes     = stop.items.filter(i => i.kind === 'note')

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

          {flights.length > 0 && (
            <Section label="Flights">
              {flights.map(item => <FlightCard key={item.id} item={item} />)}
            </Section>
          )}

          {activities.length > 0 && (
            <Section label="Activities">
              {activities.map(item => <ItemRow key={item.id} item={item} />)}
            </Section>
          )}

          {restaurants.length > 0 && (
            <Section label="Restaurants">
              {restaurants.map(item => <RestaurantCard key={item.id} item={item} />)}
            </Section>
          )}

          {notes.length > 0 && (
            <Section label="Notes">
              {notes.map(item => <ItemRow key={item.id} item={item} />)}
            </Section>
          )}

          {!accom && flights.length === 0 && activities.length === 0 && restaurants.length === 0 && notes.length === 0 && (
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
  const route = [d.origin, d.destination].filter(Boolean).join(' → ')

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
              {(d.origin_terminal || d.arrive_terminal) && (
                <div style={{ color: 'var(--kind-flight)' }} className="text-xs flex gap-3 opacity-80">
                  {d.origin_terminal && <span>Dep T{d.origin_terminal}</span>}
                  {d.arrive_terminal && <span>Arr T{d.arrive_terminal}</span>}
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
      {showDetail && <FlightDetailModal item={item} onClose={() => setShowDetail(false)} />}
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
