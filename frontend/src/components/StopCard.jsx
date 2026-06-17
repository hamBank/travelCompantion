import { useState } from 'react'
import { updateStopStatus } from '../api.js'
import ItemRow from './ItemRow.jsx'

const STATUS_CYCLE = { planned: 'confirmed', confirmed: 'completed', completed: 'planned', cancelled: 'planned' }
const STATUS_COLOR = { planned: '#9399b2', confirmed: '#89dceb', completed: '#a6e3a1', cancelled: '#f38ba8' }

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function fmtDateTime(val) {
  if (!val) return null
  const [datePart, timePart] = val.split('T')
  const dateStr = new Date(datePart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return timePart ? `${dateStr} ${timePart}` : dateStr
}

export default function StopCard({ stop, index, onUpdate }) {
  const [open, setOpen] = useState(index === 0)
  const [status, setStatus] = useState(stop.status)
  const [busy, setBusy] = useState(false)

  const accom = stop.items.find(i => i.kind === 'accommodation')
  const activities = stop.items.filter(i => i.kind === 'activity')
  const restaurants = stop.items.filter(i => i.kind === 'restaurant')
  const notes = stop.items.filter(i => i.kind === 'note')

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
    <div style={{ background: '#2a2a3e', borderRadius: '0.75rem', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-5 py-4 flex items-center gap-3 text-left hover:opacity-80 transition-opacity"
      >
        <span style={{ color: '#6c7086', fontSize: '0.7rem', minWidth: '1.2rem' }}>{index + 1}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{stop.location}</div>
          {(stop.arrive || stop.depart) && (
            <div style={{ color: '#6c7086' }} className="text-xs mt-0.5">
              {fmtDate(stop.arrive)}{stop.depart ? ` → ${fmtDate(stop.depart)}` : ''}
            </div>
          )}
        </div>
        <button
          onClick={cycleStatus}
          style={{ color: STATUS_COLOR[status], fontSize: '0.7rem' }}
          className="capitalize hover:opacity-70 transition-opacity shrink-0"
        >
          {status}
        </button>
        <span style={{ color: '#6c7086', fontSize: '0.65rem' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid #313244' }} className="px-5 py-4 space-y-4">
          {accom && (
            <Section label="Accommodation">
              <div className="text-sm">
                {accom.link
                  ? <a href={accom.link} target="_blank" rel="noreferrer"
                      style={{ color: '#cba6f7' }} className="hover:underline">{accom.name}</a>
                  : <span>{accom.name}</span>
                }
              </div>
              {accom.details?.location && (
                <p style={{ color: '#9399b2' }} className="text-xs mt-0.5">{accom.details.location}</p>
              )}
              {(accom.details?.checkin || accom.details?.checkout) && (
                <p style={{ color: '#9399b2' }} className="text-xs mt-1">
                  {[accom.details.checkin && `In: ${fmtDateTime(accom.details.checkin)}`,
                    accom.details.checkout && `Out: ${fmtDateTime(accom.details.checkout)}`]
                    .filter(Boolean).join('  ·  ')}
                </p>
              )}
              {accom.details?.booking_ref && (
                <p style={{ color: '#6c7086' }} className="text-xs mt-0.5">Ref: {accom.details.booking_ref}</p>
              )}
              {(accom.cost || accom.details?.amount_paid) && (
                <p style={{ color: '#6c7086' }} className="text-xs mt-0.5">
                  {[accom.cost && `Cost: ${accom.cost}`,
                    accom.details?.amount_paid && `Paid: ${accom.details.amount_paid}`]
                    .filter(Boolean).join('  ·  ')}
                </p>
              )}
              {accom.details?.description && (
                <p style={{ color: '#6c7086' }} className="text-xs mt-1">{accom.details.description}</p>
              )}
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

          {!accom && activities.length === 0 && restaurants.length === 0 && notes.length === 0 && (
            <p style={{ color: '#6c7086' }} className="text-xs">No details recorded.</p>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ label, children }) {
  return (
    <div>
      <p style={{ color: '#6c7086' }} className="text-xs uppercase tracking-wide mb-2">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}
