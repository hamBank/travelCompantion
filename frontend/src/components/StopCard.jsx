import { useState } from 'react'
import { updateStopStatus } from '../api.js'
import ItemRow from './ItemRow.jsx'

const STATUS_CYCLE = { planned: 'confirmed', confirmed: 'completed', completed: 'planned', cancelled: 'planned' }
const STATUS_COLOR = { planned: '#9399b2', confirmed: '#89dceb', completed: '#a6e3a1', cancelled: '#f38ba8' }

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export default function StopCard({ stop, index, onUpdate }) {
  const [open, setOpen] = useState(index === 0)
  const [status, setStatus] = useState(stop.status)
  const [busy, setBusy] = useState(false)

  const activities = stop.items.filter(i => i.kind === 'activity')
  const restaurants = stop.items.filter(i => i.kind === 'restaurant')

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
          {stop.accommodation && (
            <Section label="Accommodation">
              <div className="text-sm">
                {stop.accommodation_link
                  ? <a href={stop.accommodation_link} target="_blank" rel="noreferrer"
                      style={{ color: '#cba6f7' }} className="hover:underline">{stop.accommodation}</a>
                  : <span>{stop.accommodation}</span>
                }
              </div>
              {stop.accommodation_notes && (
                <p style={{ color: '#6c7086' }} className="text-xs mt-1">{stop.accommodation_notes}</p>
              )}
              {(stop.check_in || stop.check_out) && (
                <p style={{ color: '#9399b2' }} className="text-xs mt-1">
                  {[stop.check_in && `In: ${stop.check_in}`, stop.check_out && `Out: ${stop.check_out}`]
                    .filter(Boolean).join('  ·  ')}
                </p>
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

          {!stop.accommodation && activities.length === 0 && restaurants.length === 0 && (
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
