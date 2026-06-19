import { useEffect, useState } from 'react'
import { updateItem } from '../api.js'

const DB_HOSTS = ['https://v6.db.transport.rest', 'https://v5.db.transport.rest']

function hhmm(iso) { try { return iso ? iso.slice(11, 16) : null } catch { return null } }
function isoTrim(iso) { try { return iso ? iso.slice(0, 16) : null } catch { return null } }

function mkChk(field, key, stored, live, updateValue) {
  if (live == null) return null
  const storedS = (stored || '').trim()
  const liveS   = String(live).trim()
  const match   = storedS ? storedS.toLowerCase() === liveS.toLowerCase() : null
  const upd     = (updateValue ?? live)
  return { field, key, stored: storedS || null, live: liveS, update_value: typeof upd === 'string' ? upd.trim() : String(upd), match }
}

async function liveRailCheck(item) {
  const d = item.details ?? {}
  const trainNumber = (d.train_number || '').trim()
  const originName  = (d.origin || '').trim()
  if (!trainNumber) throw new Error('No train number stored')
  if (!originName)  throw new Error('No origin station stored — add it in the edit form first')

  const trainKey = trainNumber.replace(/\s/g, '').toUpperCase()
  let lastErr = 'DB REST API temporarily unavailable — try again later'

  for (const host of DB_HOSTS) {
    try {
      const locRes = await fetch(`${host}/locations?` + new URLSearchParams({ query: originName, results: 3, stops: true, language: 'en' }))
      if (locRes.status === 503 || !locRes.ok) { lastErr = `API unavailable (${host})`; continue }
      const locs = await locRes.json()
      if (!locs?.length) return { found: false, train_number: trainNumber, checks: [] }

      const stopId   = locs[0].id
      const stopName = locs[0].name || originName

      const depP = new URLSearchParams({ results: 30, duration: 20, language: 'en', stopovers: false })
      if (d.depart_time) depP.set('when', d.depart_time)
      const depRes = await fetch(`${host}/stops/${stopId}/departures?${depP}`)
      if (!depRes.ok) { lastErr = `Departures failed (${depRes.status})`; continue }
      const depBody = await depRes.json()

      const deps = depBody.departures ?? (Array.isArray(depBody) ? depBody : [])
      const dep  = deps.find(x => (x.line?.name || '').replace(/\s/g, '').toUpperCase() === trainKey)
      if (!dep) return { found: false, train_number: trainNumber, checks: [] }

      const line        = dep.line ?? {}
      const depPlanned  = dep.plannedWhen
      const depPlatform = dep.plannedPlatform ?? dep.platform
      const operatorNm  = line.operator?.name ?? null
      const tripId      = dep.tripId

      let arrPlanned = null, arrPlatform = null, destName = null
      if (tripId) {
        try {
          const tRes = await fetch(`${host}/trips/${encodeURIComponent(tripId)}?stopovers=true&language=en`)
          if (tRes.ok) {
            const stopovers  = (await tRes.json()).trip?.stopovers ?? []
            const destStored = (d.destination || '').trim().toUpperCase()
            for (const sv of stopovers) {
              const svName = sv.stop?.name ?? ''
              if (destStored && svName.toUpperCase().includes(destStored)) {
                arrPlanned = sv.plannedArrival; arrPlatform = sv.plannedArrivalPlatform ?? sv.arrivalPlatform; destName = svName; break
              }
            }
            if (!arrPlanned && stopovers.length) {
              const last = stopovers[stopovers.length - 1]
              arrPlanned = last.plannedArrival; arrPlatform = last.plannedArrivalPlatform ?? last.arrivalPlatform; destName = last.stop?.name
            }
          }
        } catch { /* non-fatal */ }
      }

      return {
        found: true,
        train_number: line.name || trainNumber,
        checks: [
          mkChk('Origin',       'origin',          d.origin,          stopName),
          mkChk('Destination',  'destination',     d.destination,     destName),
          mkChk('Operator',     'operator',        d.operator,        operatorNm),
          mkChk('Depart time',  'depart_time',     hhmm(d.depart_time), hhmm(depPlanned), isoTrim(depPlanned)),
          mkChk('Arrive time',  'arrive_time',     hhmm(d.arrive_time), hhmm(arrPlanned), isoTrim(arrPlanned)),
          mkChk('Dep platform', 'depart_platform', d.depart_platform, depPlatform),
          mkChk('Arr platform', 'arrive_platform', d.arrive_platform, arrPlatform),
        ].filter(Boolean),
      }
    } catch (e) { lastErr = e.message; continue }
  }
  throw new Error(lastErr)
}

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

function RailCheckPanel({ item, onItemUpdate }) {
  const [state, setState]       = useState('idle')
  const [result, setResult]     = useState(null)
  const [errMsg, setErrMsg]     = useState(null)
  const [applying, setApplying] = useState(null)

  async function run() {
    setState('loading'); setResult(null); setErrMsg(null)
    try {
      const data = await liveRailCheck(item)
      setResult(data); setState('done')
    } catch (e) {
      setErrMsg(e.message); setState('error')
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
          color: 'var(--kind-rail)',
          border: '1px solid color-mix(in srgb, var(--kind-rail) 35%, transparent)',
          background: 'color-mix(in srgb, var(--kind-rail) 8%, transparent)',
        }}
        className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 transition-opacity"
      >
        Check train
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
        <span style={{ color: 'var(--text-faint)' }} className="text-xs">
          Train {result?.train_number} not found · DB network only
        </span>
        <button onClick={run} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70">↺</button>
      </div>
    )
  }

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
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Live check · {result.train_number}
          <span style={{ color: 'var(--text-faint)' }} className="ml-1 font-normal">(DB network)</span>
        </span>
        <div className="flex items-center gap-2">
          {mismatches.length > 0
            ? <span style={{ color: 'var(--warning)' }} className="text-xs font-medium">{mismatches.length} mismatch{mismatches.length > 1 ? 'es' : ''}</span>
            : <span style={{ color: 'var(--success)' }} className="text-xs font-medium">All match</span>
          }
          <button onClick={run} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70" title="Re-check">↺</button>
        </div>
      </div>

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

export default function RailDetailModal({ item: initialItem, onClose, onSave }) {
  const [item, setItem] = useState(initialItem)
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
          <div className="flex items-center gap-2 shrink-0">
            <RailCheckPanel item={item} onItemUpdate={onItemUpdate} />
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
