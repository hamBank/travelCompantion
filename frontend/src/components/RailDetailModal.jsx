import { useEffect, useState } from 'react'
import { updateItem } from '../api.js'
import { registerModal, unregisterModal } from '../modalNav.js'
import { useSwipeNav } from '../swipeNav.js'
import { aggregateBaggage } from '../baggage.js'
import DetailActions from './DetailActions.jsx'
import ItemHistoryModal from './ItemHistoryModal.jsx'
import PassengersTable from './PassengersTable.jsx'
import RichText from './RichText.jsx'
import CopyText from './CopyText.jsx'
import { Copy } from 'lucide-react'
import { fmtDayTime } from '../dates.js'

const DB_HOSTS = ['https://v6.db.transport.rest', 'https://v5.db.transport.rest']
const SWISS    = 'https://transport.opendata.ch/v1'

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

// fetch with AbortController timeout — avoids hanging 10 s on downed servers
async function fetchT(url, ms = 4000) {
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try   { const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(timer); return r }
  catch (e) { clearTimeout(timer); throw e }
}

// Match a journey object against the user's stored train number.
// Tries: raw name, stripped leading zeros, category+name, category+bare.
// "017701"/"TER017701"/"TER 017701"/"TER17701"/"TER 17701" all match "TER 17701".
function matchesJourney(jrn, trainKey) {
  if (!jrn) return false
  const N    = s => s.replace(/[\s\-]/g, '').toUpperCase()
  const name = String(jrn.name ?? '')
  const cat  = String(jrn.category ?? '').toUpperCase()
  const bare = name.replace(/^0+/, '') || name   // strip leading zeros
  return [name, bare, cat + name, cat + bare].map(N).includes(trainKey)
}

export async function liveRailCheck(item) {
  const d = item.details ?? {}
  const trainNumber = (d.train_number || '').trim()
  const originName  = (d.origin || '').trim()
  if (!trainNumber) throw new Error('No train number stored')
  if (!originName)  throw new Error('No origin station stored — add it in the edit form first')

  const norm     = s => s.replace(/[\s\-]/g, '').toUpperCase()
  const trainKey = norm(trainNumber)

  // ── 1. DB REST hosts (German/Dutch trains; skip fast if down or no CORS) ─────
  for (const host of DB_HOSTS) {
    try {
      const locRes = await fetchT(`${host}/locations?` + new URLSearchParams({ query: originName, results: 3, stops: true, language: 'en' }))
      if (!locRes.ok) continue
      const locs = await locRes.json()
      if (!locs?.length) return { found: false, train_number: trainNumber, checks: [] }

      const stopId   = locs[0].id
      const stopName = locs[0].name || originName

      const depP = new URLSearchParams({ results: 30, duration: 20, language: 'en', stopovers: false })
      if (d.depart_time) depP.set('when', d.depart_time)
      const depRes = await fetchT(`${host}/stops/${stopId}/departures?${depP}`)
      if (!depRes.ok) continue
      const depBody = await depRes.json()

      const deps = depBody.departures ?? (Array.isArray(depBody) ? depBody : [])
      const dep  = deps.find(x => norm(x.line?.name || '') === trainKey)
      if (!dep) return { found: false, train_number: trainNumber, checks: [] }

      const line        = dep.line ?? {}
      const depPlanned  = dep.plannedWhen
      const depPlatform = dep.plannedPlatform ?? dep.platform
      const operatorNm  = line.operator?.name ?? null
      const tripId      = dep.tripId

      let arrPlanned = null, arrPlatform = null, destName = null
      if (tripId) {
        try {
          const tRes = await fetchT(`${host}/trips/${encodeURIComponent(tripId)}?stopovers=true&language=en`)
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
        checks: buildChecks(d, { stopName, destName, operatorNm, depPlanned, arrPlanned, depPlatform, arrPlatform }),
      }
    } catch { continue }
  }

  // ── 2. Swiss Open Transport API (TGV/TER/ICE/ÖBB/SBB — CORS open, no key) ──
  // journey.name is an internal 6-digit ID ("017701"); matchesJourney() tries
  // bare ("17701") and category-prefixed ("TER17701", "TER 17701") variants.
  try {
    const destName = (d.destination || '').trim()

    if (destName) {
      const p = new URLSearchParams({ from: originName, to: destName, limit: 10 })
      if (d.depart_time) p.set('datetime', d.depart_time.slice(0, 16).replace('T', ' '))
      const res = await fetch(`${SWISS}/connections?${p}`)
      if (res.ok) {
        const { connections } = await res.json()
        // Search all sections of each connection, not just the first
        const conn = (connections ?? []).find(c =>
          c.sections?.some(s => matchesJourney(s.journey, trainKey))
        )
        if (conn) {
          const sec = conn.sections?.find(s => matchesJourney(s.journey, trainKey)) ?? {}
          const jrn = sec.journey ?? {}
          const bare = String(jrn.name ?? '').replace(/^0+/, '')
          return {
            found: true,
            train_number: [jrn.category, bare].filter(Boolean).join(' ') || trainNumber,
            checks: buildChecks(d, {
              stopName:    conn.from?.station?.name,
              destName:    conn.to?.station?.name,
              operatorNm:  jrn.operator,
              depPlanned:  conn.from?.departure,
              arrPlanned:  conn.to?.arrival,
              depPlatform: conn.from?.platform,
              arrPlatform: conn.to?.platform,
            }),
          }
        }
        // No matching journey in connections — return not-found to avoid falling through to stationboard
        if ((connections ?? []).length > 0) return { found: false, train_number: trainNumber, checks: [] }
      }
    }

    // Stationboard fallback — departure info only (no destination needed)
    const p2 = new URLSearchParams({ station: originName, limit: 60, type: 'departure' })
    if (d.depart_time) p2.set('datetime', d.depart_time.slice(0, 16).replace('T', ' '))
    const res2 = await fetch(`${SWISS}/stationboard?${p2}`)
    if (res2.ok) {
      const { stationboard } = await res2.json()
      // stationboard entries share the same fields (name, category) as journey objects
      const dep = (stationboard ?? []).find(s => matchesJourney(s, trainKey))
      if (!dep) return { found: false, train_number: trainNumber, checks: [] }
      const bare = String(dep.name ?? '').replace(/^0+/, '')
      return {
        found: true,
        train_number: [dep.category, bare].filter(Boolean).join(' ') || trainNumber,
        checks: buildChecks(d, {
          stopName:    originName,
          operatorNm:  dep.operator,
          depPlanned:  dep.stop?.departure,
          depPlatform: dep.stop?.platform,
        }),
      }
    }
  } catch { /* fall through */ }

  throw new Error('Rail API temporarily unavailable — try again later')
}

function buildChecks(d, { stopName, destName, operatorNm, depPlanned, arrPlanned, depPlatform, arrPlatform } = {}) {
  return [
    mkChk('Origin',       'origin',          d.origin,          stopName   ?? null),
    mkChk('Destination',  'destination',     d.destination,     destName   ?? null),
    mkChk('Operator',     'operator',        d.operator,        operatorNm ?? null),
    mkChk('Depart time',  'depart_time',     hhmm(d.depart_time), hhmm(depPlanned), isoTrim(depPlanned)),
    mkChk('Arrive time',  'arrive_time',     hhmm(d.arrive_time), hhmm(arrPlanned), isoTrim(arrPlanned)),
    mkChk('Dep platform', 'depart_platform', d.depart_platform, depPlatform ?? null),
    mkChk('Arr platform', 'arrive_platform', d.arrive_platform, arrPlatform ?? null),
  ].filter(Boolean)
}

const fmtDateTime = fmtDayTime

function Row({ label, value }) {
  if (!value) return null
  return (
    <div className="flex gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-faint)', minWidth: '8rem' }} className="text-xs uppercase tracking-wide shrink-0 pt-0.5">
        {label}
      </span>
      <span style={{ color: 'var(--text)' }} className="text-sm break-words min-w-0 flex-1">
        {typeof value === 'string'
          ? <CopyText value={value}><RichText>{value}</RichText></CopyText>
          : value}
      </span>
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
          Not found in DB / Swiss networks — some regional operators (e.g. MOBIGO) are not covered
        </span>
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

export default function RailDetailModal({ item: initialItem, onClose, onSave, onEdit, onDeleted, isNavModal = false }) {
  const [item, setItem] = useState(initialItem)
  const [showHistory, setShowHistory] = useState(false)
  const d = item.details ?? {}

  function onItemUpdate(updated) {
    setItem(updated)
    onSave?.(updated)
  }

  useEffect(() => {
    registerModal(item.id, onClose)
    return () => unregisterModal()
  }, [item.id, onClose])

  // mobile: swipe left/right = next/prev (mirrors j/k)
  useSwipeNav(direction => window.dispatchEvent(new CustomEvent('modalNav', { detail: { itemId: item.id, direction } })))

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'j' || e.key === 'k')
        window.dispatchEvent(new CustomEvent('modalNav', { detail: { itemId: item.id, direction: e.key === 'j' ? 'next' : 'prev' } }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, item.id])

  const route = [d.origin, d.destination].filter(Boolean).join(' → ')
  const trainLabel = [d.train_number, d.operator].filter(Boolean).join(' · ')

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
            {trainLabel && (
              <div style={{ color: 'var(--kind-rail)' }} className="text-xs mt-0.5">{trainLabel}</div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!/mobigo/i.test(d.operator || '') && (
              <RailCheckPanel item={item} onItemUpdate={onItemUpdate} />
            )}
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
            {!Array.isArray(d.passengers) && <Row label="Seats" value={d.seats} />}
            {!Array.isArray(d.passengers) && <Row label="Meal"  value={d.meal} />}
            {Array.isArray(d.passengers) && (() => {
              const summary = aggregateBaggage(d.passengers)
              return summary ? <Row label="Baggage" value={summary} /> : null
            })()}
            <PassengersTable passengers={d.passengers} label="Passengers" />
            {!Array.isArray(d.passengers) && <Row label="Loyalty" value={d.loyalty_info} />}
            <Row label="Notes"      value={item.notes} />
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
                    ? <span className="flex items-center gap-1.5 min-w-0">
                        <a href={item.link} target="_blank" rel="noreferrer"
                          style={{ color: 'var(--accent)' }} className="hover:underline break-all">{d.booking_ref}</a>
                        {/* The ref doubles as a link here, so clicking it navigates —
                            give copy its own affordance instead. */}
                        <CopyText value={d.booking_ref}><span title="Copy booking ref" aria-label="Copy booking ref"><Copy size={13} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }} /></span></CopyText>
                      </span>
                    : <CopyText value={d.booking_ref}>{d.booking_ref}</CopyText>
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
                  <CopyText value={d.booking_phone}>{d.booking_phone}</CopyText>
                </div>
              )}
              {item.cost && (
                <div className="flex justify-between gap-4 text-sm">
                  <span style={{ color: 'var(--text-faint)' }}>Cost</span>
                  <CopyText value={item.cost}>{item.cost}</CopyText>
                </div>
              )}
            </div>
          )}
        </div>

        <DetailActions item={item} onEdit={onEdit} onDeleted={onDeleted} onClose={onClose}
                       onHistory={() => setShowHistory(true)} onStatusChange={onItemUpdate} />
      </div>
    </div>
    {showHistory && <ItemHistoryModal item={item} onClose={() => setShowHistory(false)} />}
    </>
  )
}
