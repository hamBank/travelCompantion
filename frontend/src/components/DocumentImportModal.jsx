import { useState } from 'react'
import { parseDocument, createItem } from '../api.js'
import { KIND_VAR, KIND_LABEL, KIND_OPTIONS } from '../kinds.js'
import { fmtDay, fmtDayTime } from '../dates.js'

const CONFIDENCE_COLOR = {
  high: 'var(--success)',
  medium: 'var(--warning)',
  low: 'var(--error)',
}

// Detail keys shown first in the preview; everything else follows alphabetically.
const DETAIL_ORDER = [
  'origin', 'destination', 'depart_time', 'arrive_time', 'train_number',
  'flight_number', 'operator', 'airline', 'location', 'checkin', 'checkout',
  'depart_platform', 'arrive_platform', 'origin_terminal', 'arrive_terminal',
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

const labelize = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

export default function DocumentImportModal({ tripId, onClose, onCreated }) {
  const [stage, setStage] = useState('pick') // pick | parsing | review | saving
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null)
  const [kind, setKind] = useState('activity')
  const [name, setName] = useState('')
  const [stopId, setStopId] = useState('')

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null); setStage('parsing')
    try {
      const result = await parseDocument(tripId, file)
      setPreview(result)
      setKind(result.item.kind)
      setName(result.item.name)
      setStopId(result.matched_stop_id != null ? String(result.matched_stop_id) : '')
      setStage('review')
    } catch (err) {
      setError(err.message)
      setStage('pick')
    }
  }

  async function handleCreate() {
    if (!stopId) { setError('Pick a stop for this item.'); return }
    setStage('saving'); setError(null)
    try {
      const { item } = preview
      await createItem(Number(stopId), {
        kind,
        name: name.trim() || 'Imported item',
        scheduled_at: item.scheduled_at || null,
        link: item.link || '',
        cost: item.cost || '',
        notes: item.notes || '',
        status: 'pending',
        details: item.details || {},
      })
      onCreated()
    } catch (err) {
      setError(err.message)
      setStage('review')
    }
  }

  const item = preview?.item
  const color = KIND_VAR[kind] ?? 'var(--text-muted)'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-xl w-full max-w-md max-h-[85vh] overflow-y-auto p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ color: 'var(--text)' }} className="font-semibold text-base">Import from document</h2>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-lg leading-none hover:opacity-70">✕</button>
        </div>

        {error && <p style={{ color: 'var(--error)' }} className="text-xs mb-3">{error}</p>}

        {stage === 'pick' && (
          <>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs mb-4">
              Upload a booking email (.eml), ticket PDF, or text file. It'll be read, classified,
              matched to a stop, and turned into a record you can review before saving.
            </p>
            <label
              style={{ color: 'var(--accent)', border: '1px dashed color-mix(in srgb, var(--accent) 40%, transparent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}
              className="block text-center text-sm px-4 py-6 rounded-lg cursor-pointer hover:opacity-80 transition-opacity"
            >
              Choose a document…
              <input type="file" accept=".eml,.pdf,.txt,.md,.html,.htm,message/rfc822,application/pdf,text/plain" onChange={handleFile} className="hidden" />
            </label>
          </>
        )}

        {stage === 'parsing' && (
          <p style={{ color: 'var(--text-muted)' }} className="text-sm text-center py-8">Reading & extracting…</p>
        )}

        {(stage === 'review' || stage === 'saving') && item && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 28%, transparent)` }}
                className="text-xs px-2 py-0.5 rounded"
              >
                {KIND_LABEL[kind] ?? kind}
              </span>
              <span style={{ color: CONFIDENCE_COLOR[preview.confidence] ?? 'var(--text-faint)' }} className="text-xs">
                {preview.confidence} confidence
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Kind</label>
              <select
                value={kind}
                onChange={e => setKind(e.target.value)}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="rounded-lg px-3 py-2 text-sm outline-none"
              >
                {KIND_OPTIONS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Stop</label>
              <select
                value={stopId}
                onChange={e => setStopId(e.target.value)}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="rounded-lg px-3 py-2 text-sm outline-none"
              >
                <option value="">— Select a stop —</option>
                {preview.stops.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.location}{s.arrive ? ` · ${fmtDay(s.arrive)}` : ''}
                  </option>
                ))}
              </select>
              {preview.match_reason && (
                <span style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5">{preview.match_reason}</span>
              )}
            </div>

            {(item.scheduled_at || item.cost) && (
              <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                {item.scheduled_at && <span>🕑 {fmtDayTime(item.scheduled_at)}</span>}
                {item.cost && <span>💳 {item.cost}</span>}
              </div>
            )}

            {orderedDetails(item.details).length > 0 && (
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }} className="rounded-lg p-3 space-y-1">
                {orderedDetails(item.details).map(([k, v]) => (
                  <div key={k} className="flex gap-2 text-xs">
                    <span style={{ color: 'var(--text-faint)' }} className="w-28 shrink-0">{labelize(k)}</span>
                    <span style={{ color: 'var(--text)' }} className="flex-1 break-words">{String(v)}</span>
                  </div>
                ))}
              </div>
            )}

            {item.notes && (
              <p style={{ color: 'var(--text-muted)' }} className="text-xs italic">{item.notes}</p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={handleCreate}
                disabled={stage === 'saving'}
                style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                className="flex-1 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                {stage === 'saving' ? 'Adding…' : 'Add record'}
              </button>
              <button
                onClick={onClose}
                style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                className="rounded-lg px-4 py-2 text-sm hover:opacity-80 transition-opacity"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
