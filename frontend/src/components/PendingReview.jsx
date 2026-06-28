import { useState, useEffect } from 'react'
import { getPending, updatePending, applyPending, discardPending, getTrips, getTripTimeline, getIngestedEmail, downloadIngestedEmail } from '../api.js'
import { KIND_VAR, KIND_LABEL, KIND_OPTIONS } from '../kinds.js'
import { fmtDay, fmtDayTime } from '../dates.js'
import { airportName } from '../airportNames.js'

function flightDisplayName(row) {
  const d = (row.payload || {}).details || {}
  const o = d.origin, dest = d.destination
  if ((row.kind === 'flight' || row.kind === 'rail') && o && dest)
    return `${airportName(o)} → ${airportName(dest)}`
  return null
}

const CONFIDENCE_COLOR = { high: 'var(--success)', medium: 'var(--warning)', low: 'var(--error)' }
const labelize = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

const DETAIL_ORDER = [
  'origin', 'destination', 'depart_time', 'arrive_time', 'train_number',
  'flight_number', 'operator', 'airline', 'location', 'checkin', 'checkout',
  'seats', 'coach', 'booking_ref', 'duration',
]
function orderedDetails(details) {
  const keys = Object.keys(details || {}).filter(k => {
    const v = details[k]
    return v !== null && v !== undefined && String(v).trim() !== ''
  })
  keys.sort((a, b) => {
    const ia = DETAIL_ORDER.indexOf(a), ib = DETAIL_ORDER.indexOf(b)
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    return a.localeCompare(b)
  })
  return keys.map(k => [k, details[k]])
}

export default function PendingReview({ tripId = null, stops = [], onClose, onChanged }) {
  const isGlobal = tripId == null
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [trips, setTrips] = useState([])
  const [stopsByTrip, setStopsByTrip] = useState({})
  // source email viewer: { [rowId]: { open: bool, loading: bool, data: obj|null, err: str|null } }
  const [emailViewer, setEmailViewer] = useState({})

  async function ensureStops(tid) {
    if (!tid || stopsByTrip[tid]) return
    try {
      const tl = await getTripTimeline(tid)
      setStopsByTrip(m => ({ ...m, [tid]: tl.stops || [] }))
    } catch (_) { /* leave empty */ }
  }

  async function load() {
    setError(null)
    try {
      const data = await getPending(tripId)
      setRows(data)
      if (isGlobal) {
        for (const r of data) if (r.trip_id) ensureStops(r.trip_id)
      }
    } catch (e) { setError(e.message); setRows([]) }
  }
  useEffect(() => { load() }, [tripId])
  useEffect(() => { if (isGlobal) getTrips().then(setTrips).catch(() => {}) }, [isGlobal])

  function stopsFor(row) {
    return isGlobal ? (stopsByTrip[row.trip_id] || []) : stops
  }

  async function changeTrip(row, newTripId) {
    const tid = newTripId ? Number(newTripId) : null
    setError(null)
    patchLocal(row.id, { trip_id: tid, suggested_stop_id: null, op: 'create', target_item_id: null, diff: null })
    if (tid) {
      await ensureStops(tid)
      try { await updatePending(row.id, { trip_id: tid }) } catch (e) { setError(e.message) }
    }
  }

  function patchLocal(id, patch) {
    setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))
  }
  function patchPayload(id, key, val) {
    setRows(rs => rs.map(r => (r.id === id ? { ...r, payload: { ...r.payload, [key]: val } } : r)))
  }

  async function apply(row) {
    if (isGlobal && !row.trip_id) { setError('Pick a trip for this item first.'); return }
    if (!row.suggested_stop_id) { setError('Pick a stop for this item first.'); return }
    setBusyId(row.id); setError(null)
    try {
      const cleanName = flightDisplayName(row) || (row.payload || {}).name || 'Imported item'
      await updatePending(row.id, {
        trip_id: row.trip_id ?? tripId,
        suggested_stop_id: Number(row.suggested_stop_id),
        kind: row.kind,
        payload: { ...(row.payload || {}), name: cleanName },
      })
      await applyPending(row.id)
      await load()
      onChanged?.()
    } catch (e) { setError(e.message) }
    finally { setBusyId(null) }
  }

  async function discard(row) {
    setBusyId(row.id); setError(null)
    try { await discardPending(row.id); await load(); onChanged?.() }
    catch (e) { setError(e.message) }
    finally { setBusyId(null) }
  }

  async function toggleEmail(row) {
    const emailId = row.source_email_id
    if (!emailId) return
    const cur = emailViewer[row.id] || {}
    if (cur.open) {
      setEmailViewer(v => ({ ...v, [row.id]: { ...cur, open: false } }))
      return
    }
    // Open: show immediately with loading state, fetch if not yet cached
    setEmailViewer(v => ({ ...v, [row.id]: { open: true, loading: !cur.data, data: cur.data || null, err: null } }))
    if (!cur.data) {
      try {
        const data = await getIngestedEmail(emailId)
        setEmailViewer(v => ({ ...v, [row.id]: { open: true, loading: false, data, err: null } }))
      } catch (e) {
        setEmailViewer(v => ({ ...v, [row.id]: { open: true, loading: false, data: null, err: e.message } }))
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ color: 'var(--text)' }} className="font-semibold text-base">
            Pending imports{rows ? ` (${rows.length})` : ''}
          </h2>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-lg leading-none hover:opacity-70">✕</button>
        </div>

        {error && <p style={{ color: 'var(--error)' }} className="text-xs mb-3">{error}</p>}

        {rows === null && <p style={{ color: 'var(--text-muted)' }} className="text-sm text-center py-8">Loading…</p>}
        {rows && rows.length === 0 && (
          <p style={{ color: 'var(--text-faint)' }} className="text-sm text-center py-8">Nothing to review.</p>
        )}

        <div className="space-y-4">
          {rows?.map(row => {
            const color = KIND_VAR[row.kind] ?? 'var(--text-muted)'
            const p = row.payload || {}
            // For flight/rail use airportName to build "City → City" regardless of what's stored
            const displayName = flightDisplayName(row) || p.name || ''
            const details = orderedDetails(p.details)
            const busy = busyId === row.id
            return (
              <div key={row.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }} className="rounded-lg p-3 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 28%, transparent)` }} className="text-xs px-2 py-0.5 rounded">
                    {KIND_LABEL[row.kind] ?? row.kind}
                  </span>
                  {row.op === 'update' && (
                    <span style={{ color: 'var(--warning)' }} className="text-xs">updates existing</span>
                  )}
                  <span style={{ color: CONFIDENCE_COLOR[row.confidence] ?? 'var(--text-faint)' }} className="text-xs">{row.confidence} confidence</span>
                </div>

                <input
                  value={displayName}
                  onChange={e => patchPayload(row.id, 'name', e.target.value)}
                  style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                />

                {isGlobal && (
                  <select
                    value={row.trip_id ?? ''}
                    onChange={e => changeTrip(row, e.target.value)}
                    style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                    className="w-full rounded-lg px-2 py-2 text-sm outline-none"
                  >
                    <option value="">— Select a trip —</option>
                    {trips.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={row.kind}
                    onChange={e => patchLocal(row.id, { kind: e.target.value })}
                    style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                    className="rounded-lg px-2 py-2 text-sm outline-none"
                  >
                    {KIND_OPTIONS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                  </select>
                  <select
                    value={row.suggested_stop_id ?? ''}
                    onChange={e => patchLocal(row.id, { suggested_stop_id: e.target.value ? Number(e.target.value) : null })}
                    disabled={isGlobal && !row.trip_id}
                    style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' }}
                    className="rounded-lg px-2 py-2 text-sm outline-none disabled:opacity-50"
                  >
                    <option value="">— Select a stop —</option>
                    {stopsFor(row).map(s => (
                      <option key={s.id} value={s.id}>
                        {s.location}{s.arrive ? ` · ${fmtDay(s.arrive)}` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {row.match_reason && (
                  <p style={{ color: 'var(--text-faint)' }} className="text-xs">{row.match_reason}</p>
                )}

                {(p.scheduled_at || p.cost) && (
                  <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {p.scheduled_at && <span>🕑 {fmtDayTime(p.scheduled_at)}</span>}
                    {p.cost && <span>💳 {p.cost}</span>}
                  </div>
                )}

                {details.length > 0 && (
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} className="rounded-lg p-2.5 space-y-1">
                    {details.map(([k, v]) => (
                      <div key={k} className="flex gap-2 text-xs">
                        <span style={{ color: 'var(--text-faint)' }} className="w-28 shrink-0">{labelize(k)}</span>
                        <span style={{ color: 'var(--text)' }} className="flex-1 break-words">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {row.op === 'update' && row.diff && Object.keys(row.diff.after || {}).length > 0 && (
                  <div style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }} className="rounded-lg p-2.5 space-y-1">
                    <p style={{ color: 'var(--warning)' }} className="text-xs font-medium">Changes to the existing record</p>
                    {Object.keys(row.diff.after).map(k => (
                      <div key={k} className="flex gap-2 text-xs items-baseline">
                        <span style={{ color: 'var(--text-faint)' }} className="w-24 shrink-0">{labelize(k)}</span>
                        <span style={{ color: 'var(--text-faint)' }} className="line-through truncate" >{String(row.diff.before?.[k] ?? '—')}</span>
                        <span style={{ color: 'var(--text-muted)' }}>→</span>
                        <span style={{ color: 'var(--text)' }} className="flex-1 break-words">{String(row.diff.after[k])}</span>
                      </div>
                    ))}
                  </div>
                )}

                {p.notes && <p style={{ color: 'var(--text-muted)' }} className="text-xs italic">{p.notes}</p>}

                {row.source === 'email' && row.source_email_id && (() => {
                  const ev = emailViewer[row.id] || {}
                  const em = ev.data
                  return (
                    <div>
                      <button
                        onClick={() => toggleEmail(row)}
                        style={{ color: 'var(--accent)' }}
                        className="text-xs hover:opacity-75 transition-opacity"
                      >
                        {ev.open ? '▾ Hide source email' : '▸ View source email'}
                      </button>
                      {ev.open && (
                        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} className="rounded-lg mt-2 p-3 space-y-2">
                          {ev.loading && <p style={{ color: 'var(--text-faint)' }} className="text-xs">Loading…</p>}
                          {ev.err && <p style={{ color: 'var(--error)' }} className="text-xs">{ev.err}</p>}
                          {em && (
                            <>
                              <div className="space-y-0.5">
                                {em.subject && (
                                  <div className="flex gap-2 text-xs">
                                    <span style={{ color: 'var(--text-faint)' }} className="w-10 shrink-0">Subject</span>
                                    <span style={{ color: 'var(--text)' }} className="flex-1 break-words font-medium">{em.subject}</span>
                                  </div>
                                )}
                                {em.from_addr && (
                                  <div className="flex gap-2 text-xs">
                                    <span style={{ color: 'var(--text-faint)' }} className="w-10 shrink-0">From</span>
                                    <span style={{ color: 'var(--text-muted)' }} className="flex-1 break-all">{em.from_addr}</span>
                                  </div>
                                )}
                              </div>
                              {em.body_text ? (
                                <pre
                                  style={{ color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border)', fontFamily: 'inherit' }}
                                  className="text-xs rounded p-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words"
                                >{em.body_text}</pre>
                              ) : (
                                <p style={{ color: 'var(--text-faint)' }} className="text-xs italic">No text body available.</p>
                              )}
                              <button
                                onClick={() => downloadIngestedEmail(row.source_email_id).catch(() => {})}
                                style={{ color: 'var(--accent)' }}
                                className="text-xs hover:opacity-75 transition-opacity"
                              >
                                ↓ Download raw .eml
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })()}

                <div className="flex gap-2 pt-0.5">
                  <button
                    onClick={() => apply(row)}
                    disabled={busy}
                    style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                    className="flex-1 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                  >
                    {busy ? 'Applying…' : (row.op === 'update' ? 'Apply update' : 'Add to trip')}
                  </button>
                  <button
                    onClick={() => discard(row)}
                    disabled={busy}
                    style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                    className="rounded-lg px-4 py-2 text-sm disabled:opacity-50 hover:opacity-80 transition-opacity"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
