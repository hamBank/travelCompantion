import { useEffect, useState } from 'react'
import { getItemHistory } from '../api.js'

const OP_LABEL = { create: 'Created', update: 'Updated', delete: 'Deleted' }
const OP_COLOR = {
  create: 'var(--success, #22c55e)',
  update: 'var(--accent)',
  delete: 'var(--error)',
}

const SOURCE_LABEL = { email: 'email import', upload: 'document import', '': 'manual' }

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

function DiffView({ diff }) {
  if (!diff) return null
  const { before = {}, after = {} } = diff

  // Collect all changed keys (scalar fields + detail keys)
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])
  const SKIP = new Set(['details'])
  const changed = []

  for (const key of allKeys) {
    if (SKIP.has(key)) continue
    const b = before[key], a = after[key]
    const bStr = b == null ? '' : String(b)
    const aStr = a == null ? '' : String(a)
    if (bStr !== aStr) changed.push({ key, before: bStr, after: aStr })
  }

  // Detail-level diffs
  const bDet = (before.details) || {}
  const aDet = (after.details) || {}
  const detKeys = new Set([...Object.keys(bDet), ...Object.keys(aDet)])
  for (const key of detKeys) {
    const b = bDet[key], a = aDet[key]
    const bStr = b == null ? '' : (typeof b === 'object' ? JSON.stringify(b) : String(b))
    const aStr = a == null ? '' : (typeof a === 'object' ? JSON.stringify(a) : String(a))
    if (bStr !== aStr) changed.push({ key, before: bStr, after: aStr })
  }

  if (!changed.length) {
    return (
      <p style={{ color: 'var(--text-faint)', fontSize: '0.75rem' }} className="mt-1 italic">
        No field-level diff recorded
      </p>
    )
  }

  return (
    <div className="mt-2 space-y-1">
      {changed.map(({ key, before: b, after: a }) => (
        <div key={key} style={{ fontSize: '0.75rem' }}>
          <span style={{ color: 'var(--text-faint)', textTransform: 'capitalize' }}>
            {key.replace(/_/g, ' ')}
          </span>
          {b && (
            <span style={{ color: 'var(--error)', marginLeft: '0.5rem',
              textDecoration: 'line-through', opacity: 0.7 }}>
              {b.length > 60 ? b.slice(0, 60) + '…' : b}
            </span>
          )}
          <span style={{ color: 'var(--text-faint)', margin: '0 0.25rem' }}>→</span>
          <span style={{ color: 'var(--success, #22c55e)' }}>
            {a.length > 80 ? a.slice(0, 80) + '…' : a || '(cleared)'}
          </span>
        </div>
      ))}
    </div>
  )
}

function HistoryEntry({ entry }) {
  const [expanded, setExpanded] = useState(false)
  const opColor = OP_COLOR[entry.op] ?? 'var(--text-faint)'
  const hasDiff = entry.diff && (entry.op === 'update')

  return (
    <div
      style={{
        borderLeft: `3px solid ${opColor}`,
        paddingLeft: '0.75rem',
        marginBottom: '1rem',
      }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          style={{
            background: opColor, color: '#fff',
            borderRadius: '0.25rem', padding: '1px 6px',
            fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.03em',
          }}
        >
          {OP_LABEL[entry.op] ?? entry.op}
        </span>
        <span style={{ color: 'var(--text)', fontSize: '0.8rem' }}>
          {fmtDate(entry.changed_at)}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: '0.75rem' }}>
          by {entry.changed_by}
        </span>
        {entry.source && (
          <span style={{
            color: 'var(--text-faint)', fontSize: '0.7rem',
            border: '1px solid var(--border)', borderRadius: '0.25rem', padding: '0 5px',
          }}>
            {SOURCE_LABEL[entry.source] ?? entry.source}
          </span>
        )}
      </div>

      {hasDiff && (
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ color: 'var(--accent)', fontSize: '0.75rem', marginTop: '0.3rem' }}
          className="hover:underline"
        >
          {expanded ? '▲ Hide changes' : '▼ Show changes'}
        </button>
      )}
      {expanded && <DiffView diff={entry.diff} />}
    </div>
  )
}

export default function ItemHistoryModal({ item, onClose }) {
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getItemHistory(item.id)
      .then(setEntries)
      .catch(e => setError(e.message))
  }, [item.id])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
          maxWidth: '28rem',
          width: '100%',
          maxHeight: '80vh',
          borderRadius: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}
          className="px-5 py-4 flex items-center justify-between"
        >
          <div>
            <div className="font-semibold text-sm">Change History</div>
            <div style={{ color: 'var(--text-faint)', fontSize: '0.75rem' }}
                 className="truncate max-w-xs mt-0.5">
              {item.name}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-faint)' }}
            className="text-lg leading-none hover:opacity-70 shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1">
          {error && (
            <p style={{ color: 'var(--error)' }} className="text-sm">{error}</p>
          )}
          {entries === null && !error && (
            <p style={{ color: 'var(--text-faint)' }} className="text-sm">Loading…</p>
          )}
          {entries && entries.length === 0 && (
            <p style={{ color: 'var(--text-faint)' }} className="text-sm">
              No history recorded yet. History is tracked from this point forward.
            </p>
          )}
          {entries && entries.map(e => (
            <HistoryEntry key={e.id} entry={e} />
          ))}
        </div>
      </div>
    </div>
  )
}
