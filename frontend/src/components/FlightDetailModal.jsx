import { useEffect, useState } from 'react'
import { checkFlight, updateItem } from '../api.js'
import { airportName, airportLabel } from '../airportNames.js'
import DetailActions from './DetailActions.jsx'
import ItemHistoryModal from './ItemHistoryModal.jsx'
import RichText from './RichText.jsx'
import { getPowerbankPolicy } from '../powerbank.js'
import { fmtDayTime, fmtDay } from '../dates.js'

const fmtDateTime = fmtDayTime
const hhmm = v => { const m = String(v ?? '').match(/T(\d{2}:\d{2})/); return m ? m[1] : '' }

function Row({ label, value }) {
  if (!value) return null
  return (
    <div className="flex gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-faint)', minWidth: '8rem' }} className="text-xs uppercase tracking-wide shrink-0 pt-0.5">
        {label}
      </span>
      <span style={{ color: 'var(--text)' }} className="text-sm break-words min-w-0 flex-1">
        {typeof value === 'string' ? <RichText>{value}</RichText> : value}
      </span>
    </div>
  )
}

const STATUS_COLOR = {
  scheduled: 'var(--status-confirmed)',
  active:    'var(--success)',
  landed:    'var(--success)',
  cancelled: 'var(--error)',
  incident:  'var(--error)',
  diverted:  'var(--warning)',
}

function FlightCheckPanel({ item, onItemUpdate }) {
  const [state, setState]     = useState('idle')  // idle | loading | done | error
  const [result, setResult]   = useState(null)
  const [errMsg, setErrMsg]   = useState(null)
  const [applying, setApplying] = useState(null)  // key being applied

  async function run() {
    setState('loading')
    setResult(null)
    setErrMsg(null)
    try {
      const data = await checkFlight(item.id)
      setResult(data)
      setState('done')
    } catch (e) {
      setErrMsg(e.message)
      setState('error')
    }
  }

  async function applyField(c) {
    setApplying(c.key)
    try {
      const newDetails = { ...item.details, [c.key]: c.update_value }
      const updated = await updateItem(item.id, { details: newDetails })
      onItemUpdate(updated)
      setResult(prev => ({
        ...prev,
        checks: prev.checks.map(ch =>
          ch.key === c.key ? { ...ch, match: true, stored: c.live } : ch
        ),
      }))
    } catch (e) {
      setErrMsg(e.message)
    } finally {
      setApplying(null)
    }
  }

  if (state === 'idle') {
    return (
      <button
        onClick={run}
        style={{
          color: 'var(--accent-alt)',
          border: '1px solid color-mix(in srgb, var(--accent-alt) 35%, transparent)',
          background: 'color-mix(in srgb, var(--accent-alt) 8%, transparent)',
        }}
        className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 transition-opacity"
      >
        Check flight
      </button>
    )
  }

  if (state === 'loading') {
    return <span style={{ color: 'var(--text-faint)' }} className="text-xs">Checking…</span>
  }

  if (state === 'error') {
    return (
      <div className="flex items-center gap-2">
        <span style={{ color: 'var(--error)' }} className="text-xs">{errMsg}</span>
        <button onClick={run} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70">Retry</button>
      </div>
    )
  }

  if (!result?.found) {
    return (
      <div className="flex items-center gap-2">
        <span style={{ color: 'var(--text-faint)' }} className="text-xs">Flight {result?.flight_iata} not found in live data</span>
        <button onClick={run} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70">↺</button>
      </div>
    )
  }

  const statusColor = STATUS_COLOR[result.flight_status] ?? 'var(--text-muted)'
  const mismatches = result.checks.filter(c => c.match === false)

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: `1px solid ${mismatches.length ? 'color-mix(in srgb, var(--warning) 40%, transparent)' : 'color-mix(in srgb, var(--success) 40%, transparent)'}`,
        borderRadius: '0.5rem',
      }}
      className="mt-4 overflow-hidden"
    >
      {/* panel header */}
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Live check · {result.flight_iata}</span>
          {result.flight_status && (
            <span className="text-xs capitalize font-medium" style={{ color: statusColor }}>{result.flight_status}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {mismatches.length > 0
            ? <span style={{ color: 'var(--warning)' }} className="text-xs font-medium">{mismatches.length} mismatch{mismatches.length > 1 ? 'es' : ''}</span>
            : <span style={{ color: 'var(--success)' }} className="text-xs font-medium">All match</span>
          }
          <button onClick={run} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70" title="Re-check">↺</button>
        </div>
      </div>

      {/* check rows */}
      <div className="divide-y" style={{ '--tw-divide-color': 'var(--border)' }}>
        {result.checks.map(c => (
          <div key={c.field} className="flex items-start gap-2 px-3 py-2 text-xs">
            <span style={{ color: 'var(--text-faint)', width: '6rem', flexShrink: 0 }} className="uppercase tracking-wide pt-0.5">
              {c.field}
            </span>
            <div className="flex-1 min-w-0 space-y-0.5">
              {c.stored
                ? <div style={{ color: 'var(--text-muted)' }}>Stored: {c.stored}</div>
                : <div style={{ color: 'var(--text-faint)' }} className="italic">Not stored</div>
              }
              <div style={{ color: c.match === false ? 'var(--warning)' : c.match === true ? 'var(--success)' : 'var(--text)' }}>
                Live: {c.live}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {c.match !== true && (
                <button
                  onClick={() => applyField(c)}
                  disabled={applying === c.key}
                  style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
                  className="px-1.5 py-0.5 rounded text-xs font-medium disabled:opacity-40 hover:opacity-80 transition-opacity"
                >
                  {applying === c.key ? '…' : 'Apply'}
                </button>
              )}
              <span className="text-base leading-none">
                {c.match === true  && <span style={{ color: 'var(--success)' }}>✓</span>}
                {c.match === false && <span style={{ color: 'var(--warning)' }}>!</span>}
                {c.match === null  && <span style={{ color: 'var(--text-faint)' }}>–</span>}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PowerbankPanel({ airline }) {
  const p = getPowerbankPolicy(airline)
  const rows = [
    ['Max capacity', p.maxWh],
    ['Permitted',    p.number],
    ['Storage',      p.storage],
    ['In-flight use', p.usage],
  ]
  return (
    <div
      style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', borderRadius: '0.5rem' }}
      className="p-3 mt-4 space-y-1.5"
    >
      <div className="flex items-center justify-between mb-2">
        <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide font-medium">🔋 Power bank policy</p>
        <span style={{ color: 'var(--text-faint)' }} className="text-xs">{p.source}</span>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3 text-sm">
          <span style={{ color: 'var(--text-faint)', minWidth: '6.5rem' }} className="shrink-0">{label}</span>
          <span style={{ color: 'var(--text)' }} className="flex-1">{value}</span>
        </div>
      ))}
      <p style={{ color: 'var(--text-faint)' }} className="text-xs pt-1 italic">
        Rules change frequently — confirm with the airline before travel.
      </p>
    </div>
  )
}

export default function FlightDetailModal({ item: initialItem, onClose, onSave, onEdit, onDeleted }) {
  const [item, setItem] = useState(initialItem)
  const [showHistory, setShowHistory] = useState(false)
  const d = item.details ?? {}

  function onItemUpdate(updated) {
    setItem(updated)
    onSave?.(updated)
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const route = [d.origin, d.destination].filter(Boolean).map(airportName).join(' → ')
  const flightLabel = [d.flight_number, d.airline].filter(Boolean).join(' · ')

  return (
    <>
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
            {flightLabel && (
              <div style={{ color: 'var(--accent-alt)' }} className="text-xs mt-0.5">{flightLabel}</div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {d.flight_number && <FlightCheckPanel item={item} onItemUpdate={onItemUpdate} />}
            <button
              onClick={onClose}
              style={{ color: 'var(--text-faint)' }}
              className="text-lg leading-none hover:opacity-70"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {(d.origin || d.destination || d.depart_time || d.arrive_time) && (() => {
            const depTerm = [d.origin_terminal && `T${d.origin_terminal}`, d.origin_gate && `Gate ${d.origin_gate}`].filter(Boolean).join(' ')
            const arrTerm = [d.arrive_terminal && `T${d.arrive_terminal}`, d.arrive_gate && `Gate ${d.arrive_gate}`].filter(Boolean).join(' ')
            const metaBits = [d.duration, d.fare_class, d.aircraft, d.stops].filter(Boolean).join('  ·  ')
            const Endpoint = ({ code, time, tz, name, term, align }) => (
              <div className={`min-w-0 ${align === 'right' ? 'text-right' : ''}`}>
                {code && <div className="text-lg font-semibold tracking-wide">{code.toUpperCase()}</div>}
                {time && (
                  <div className="text-sm">
                    <span className="font-medium">{hhmm(time)}</span>
                    <span style={{ color: 'var(--text-faint)' }} className="text-xs ml-1">{fmtDay(time)}{tz ? ` ${tz}` : ''}</span>
                  </div>
                )}
                {name && <div style={{ color: 'var(--text-faint)' }} className="text-xs truncate">{name}</div>}
                {term && <div style={{ color: 'var(--kind-flight)' }} className="text-xs">{term}</div>}
              </div>
            )
            return (
              <div
                style={{ background: 'var(--surface)', border: '1px solid color-mix(in srgb, var(--accent-alt) 30%, transparent)', borderRadius: '0.5rem' }}
                className="p-3 mb-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <Endpoint code={d.origin} time={d.depart_time} tz={d.depart_tz} name={d.origin && airportName(d.origin)} term={depTerm} />
                  <div style={{ color: 'var(--text-faint)' }} className="text-lg shrink-0 leading-none pt-1">→</div>
                  <Endpoint code={d.destination} time={d.arrive_time} tz={d.arrive_tz} name={d.destination && airportName(d.destination)} term={arrTerm} align="right" />
                </div>
                {metaBits && (
                  <div style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }} className="text-xs mt-3 pt-2 text-center">
                    {metaBits}
                  </div>
                )}
                {d.checkin_desk && (
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs mt-1 text-center">Check-in desk: {d.checkin_desk}</div>
                )}
              </div>
            )
          })()}

          <div className="space-y-0">
            <Row label="Status"        value={d.flight_status} />
            <Row label="Seats"         value={d.seats} />
            <Row label="Baggage"       value={d.baggage} />
            <Row label="Meal"          value={d.meal} />
            <Row label="Entertainment" value={d.entertainment} />
            <Row label="Lounge"        value={d.lounge} />
            <Row label="Check-in"      value={d.checkin} />
            <Row label="Stops"         value={d.stops} />
            {(d.layover || d.connects_to) && (
              <Row label="Layover" value={[d.layover, d.connects_to && `→ ${d.connects_to}`].filter(Boolean).join(' ')} />
            )}
            <Row label="Passengers"    value={d.passengers} />
            <Row label="Loyalty"       value={d.loyalty_info} />
            <Row label="Distance"      value={d.distance} />
            <Row label="Notes"         value={item.notes} />
          </div>

          {(d.booking_ref || item.link || item.cost || d.booking_airline || d.booking_phone) && (
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
              {d.booking_airline && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>Airline tel</span>
                  <span>{d.booking_airline}</span>
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

          <PowerbankPanel airline={d.airline} />
        </div>

        <DetailActions item={item} onEdit={onEdit} onDeleted={onDeleted} onClose={onClose}
                       onHistory={() => setShowHistory(true)} />
      </div>
    </div>
    {showHistory && <ItemHistoryModal item={item} onClose={() => setShowHistory(false)} />}
    </>
  )
}
