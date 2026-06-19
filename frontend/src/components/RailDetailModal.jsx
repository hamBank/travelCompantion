import { useEffect, useState } from 'react'

function fmtDateTime(val) {
  if (!val) return null
  const [datePart, timePart] = val.split('T')
  const dateStr = new Date(datePart + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
  return timePart ? `${dateStr}  ${timePart}` : dateStr
}

function Row({ label, value }) {
  if (!value) return null
  return (
    <div className="flex gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-faint)', minWidth: '8rem' }} className="text-xs uppercase tracking-wide shrink-0 pt-0.5">
        {label}
      </span>
      <span style={{ color: 'var(--text)' }} className="text-sm break-all">{value}</span>
    </div>
  )
}

export default function RailDetailModal({ item: initialItem, onClose, onSave }) {
  const [item, setItem] = useState(initialItem)
  const d = item.details ?? {}

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const route = [d.origin, d.destination].filter(Boolean).join(' → ')
  const trainLabel = [d.train_number, d.operator].filter(Boolean).join(' · ')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: 'var(--modal-bg)',
          border: '1px solid var(--border)',
          maxWidth: '32rem',
          width: '100%',
          maxHeight: '90vh',
          borderRadius: '0.75rem',
        }}
        className="overflow-y-auto"
      >
        {/* Header */}
        <div
          style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}
          className="px-5 py-4 flex items-start justify-between gap-3 sticky top-0"
        >
          <div>
            <div className="font-semibold text-base">{route || item.name}</div>
            {trainLabel && (
              <div style={{ color: 'var(--kind-rail)' }} className="text-xs mt-0.5">{trainLabel}</div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-faint)' }}
            className="text-lg leading-none hover:opacity-70 shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {(d.depart_time || d.arrive_time) && (
            <div
              style={{
                background: 'var(--surface)',
                border: '1px solid color-mix(in srgb, var(--kind-rail) 30%, transparent)',
                borderRadius: '0.5rem',
              }}
              className="p-3 mb-4 space-y-1"
            >
              {d.depart_time && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>
                    Departs{d.origin && <span className="ml-1 font-normal" style={{ color: 'var(--text-faint)' }}>· {d.origin}</span>}
                  </span>
                  <span className="text-right">
                    {fmtDateTime(d.depart_time)}
                    {d.depart_platform && <span style={{ color: 'var(--kind-rail)' }} className="ml-2 text-xs">Plat. {d.depart_platform}</span>}
                  </span>
                </div>
              )}
              {d.arrive_time && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>
                    Arrives{d.destination && <span className="ml-1 font-normal" style={{ color: 'var(--text-faint)' }}>· {d.destination}</span>}
                  </span>
                  <span className="text-right">
                    {fmtDateTime(d.arrive_time)}
                    {d.arrive_platform && <span style={{ color: 'var(--kind-rail)' }} className="ml-2 text-xs">Plat. {d.arrive_platform}</span>}
                  </span>
                </div>
              )}
              {d.duration && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>Duration</span>
                  <span>{d.duration}</span>
                </div>
              )}
            </div>
          )}

          <div className="space-y-0">
            <Row label="Operator"   value={d.operator} />
            <Row label="Class"      value={d.rail_class} />
            <Row label="Coach"      value={d.coach} />
            <Row label="Seats"      value={d.seats} />
            <Row label="Meal"       value={d.meal} />
            <Row label="Passengers" value={d.passengers} />
            <Row label="Loyalty"    value={d.loyalty_info} />
            <Row label="Notes"      value={d.notes} />
          </div>

          {(d.booking_ref || item.link || item.cost || d.booking_phone) && (
            <div
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0.5rem' }}
              className="p-3 mt-4 space-y-1.5"
            >
              <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2 font-medium">Booking</p>
              {d.booking_ref && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>Ref</span>
                  {item.link
                    ? <a href={item.link} target="_blank" rel="noreferrer"
                        style={{ color: 'var(--accent)' }} className="hover:underline break-all">{d.booking_ref}</a>
                    : <span>{d.booking_ref}</span>
                  }
                </div>
              )}
              {!d.booking_ref && item.link && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>Link</span>
                  <a href={item.link} target="_blank" rel="noreferrer"
                     style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
                </div>
              )}
              {d.booking_phone && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>Phone</span>
                  <span>{d.booking_phone}</span>
                </div>
              )}
              {item.cost && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>Cost</span>
                  <span>{item.cost}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
