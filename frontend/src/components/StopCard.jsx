import { useState } from 'react'
import { updateStopStatus } from '../api.js'
import ItemRow from './ItemRow.jsx'
import FlightDetailModal from './FlightDetailModal.jsx'
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
              <div className="text-sm">
                {accom.link
                  ? <a href={accom.link} target="_blank" rel="noreferrer"
                      style={{ color: 'var(--accent)' }} className="hover:underline">{accom.name}</a>
                  : <span>{accom.name}</span>
                }
              </div>
              {accom.details?.location && (
                <p style={{ color: 'var(--text-muted)' }} className="text-xs mt-0.5">{accom.details.location}</p>
              )}
              {(accom.details?.checkin || accom.details?.checkout) && (
                <p style={{ color: 'var(--text-muted)' }} className="text-xs mt-1">
                  {[accom.details.checkin && `In: ${fmtDateTime(accom.details.checkin)}`,
                    accom.details.checkout && `Out: ${fmtDateTime(accom.details.checkout)}`]
                    .filter(Boolean).join('  ·  ')}
                </p>
              )}
              {accom.details?.booking_ref && (
                <p style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5">Ref: {accom.details.booking_ref}</p>
              )}
              {(accom.cost || accom.details?.amount_paid) && (
                <p style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5">
                  {[accom.cost && `Cost: ${accom.cost}`,
                    accom.details?.amount_paid && `Paid: ${accom.details.amount_paid}`]
                    .filter(Boolean).join('  ·  ')}
                </p>
              )}
              {accom.details?.description && (
                <p style={{ color: 'var(--text-faint)' }} className="text-xs mt-1">{accom.details.description}</p>
              )}
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
              {restaurants.map(item => <ItemRow key={item.id} item={item} />)}
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

function FlightCard({ item }) {
  const [showDetail, setShowDetail] = useState(false)
  const d = item.details ?? {}
  const route = [d.origin, d.destination].filter(Boolean).join(' → ')

  return (
    <>
      <button
        onClick={() => setShowDetail(true)}
        className="w-full text-left hover:opacity-80 transition-opacity"
        style={{
          background: 'var(--surface-2)',
          border: '1px solid color-mix(in srgb, var(--accent-alt) 30%, transparent)',
          borderRadius: '0.5rem',
          padding: '0.75rem',
        }}
      >
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-sm">{route || item.name}</span>
            <span style={{ color: 'var(--accent-alt)' }} className="text-xs shrink-0">
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
          {(d.fare_class || d.seats) && (
            <div style={{ color: 'var(--text-faint)' }} className="text-xs flex gap-3">
              {d.fare_class && <span>{d.fare_class}</span>}
              {d.seats && <span>Seats: {d.seats}</span>}
            </div>
          )}
        </div>
      </button>
      {showDetail && <FlightDetailModal item={item} onClose={() => setShowDetail(false)} />}
    </>
  )
}
