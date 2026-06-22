import { useState, useEffect } from 'react'
import { liveRailCheck } from './RailDetailModal.jsx'

/**
 * Live train lookup for the rail EDIT form. Runs the same check the detail modal
 * uses, but instead of saving each field via the API it calls `onApply(key, value)`
 * so values flow into the in-progress edit. Only non-matching / missing fields are
 * offered for insertion.
 */
export default function RailLookupModal({ details, onApply, onClose }) {
  const [state, setState] = useState('loading')   // loading | done | error
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [inserted, setInserted] = useState({})

  async function run() {
    setState('loading'); setError(null)
    try {
      const data = await liveRailCheck({ details })
      setResult(data); setState('done')
    } catch (e) {
      setError(e.message); setState('error')
    }
  }
  useEffect(() => { run() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const diffs = (result?.checks ?? []).filter(c => c.match === false || c.stored == null)

  function insert(c) {
    onApply(c.key, c.update_value)
    setInserted(prev => ({ ...prev, [c.key]: true }))
  }
  function insertAll() {
    diffs.forEach(c => { if (!inserted[c.key]) onApply(c.key, c.update_value) })
    setInserted(Object.fromEntries(diffs.map(c => [c.key, true])))
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-[60] p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', maxHeight: '80vh' }}
        className="w-full max-w-md rounded-2xl flex flex-col overflow-hidden"
      >
        <div style={{ borderBottom: '1px solid var(--border)' }} className="flex items-center justify-between px-5 py-4">
          <span style={{ color: 'var(--text)' }} className="font-medium text-sm">Look up train times</span>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="hover:opacity-70 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {state === 'loading' && (
            <p style={{ color: 'var(--text-faint)' }} className="text-sm">Checking live timetables…</p>
          )}

          {state === 'error' && (
            <div className="space-y-2">
              <p style={{ color: 'var(--error)' }} className="text-sm">{error}</p>
              <button onClick={run} style={{ color: 'var(--kind-rail)' }} className="text-sm hover:opacity-70">Retry</button>
            </div>
          )}

          {state === 'done' && result && !result.found && (
            <p style={{ color: 'var(--text-muted)' }} className="text-sm">
              No matching train found for “{result.train_number}”. Check the train number and origin station.
            </p>
          )}

          {state === 'done' && result?.found && diffs.length === 0 && (
            <p style={{ color: 'var(--success)' }} className="text-sm">Everything matches the live timetable ✓</p>
          )}

          {state === 'done' && diffs.length > 0 && (
            <>
              <p style={{ color: 'var(--text-faint)' }} className="text-xs">
                Live timetable differs from your entry. Insert the values you want to use.
              </p>
              {diffs.map(c => (
                <div
                  key={c.key}
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                  className="rounded-lg px-3 py-2.5"
                >
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-1">{c.field}</div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0 text-sm">
                      {c.stored && (
                        <span style={{ color: 'var(--text-faint)', textDecoration: 'line-through' }} className="mr-2">{c.stored}</span>
                      )}
                      <span style={{ color: 'var(--text)' }}>{c.live}</span>
                    </div>
                    {inserted[c.key] ? (
                      <span style={{ color: 'var(--success)' }} className="text-xs shrink-0">Inserted ✓</span>
                    ) : (
                      <button
                        onClick={() => insert(c)}
                        style={{ color: 'var(--kind-rail)', border: '1px solid color-mix(in srgb, var(--kind-rail) 35%, transparent)' }}
                        className="text-xs px-2.5 py-1 rounded-lg font-medium hover:opacity-80 transition-opacity shrink-0"
                      >
                        Insert
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} className="flex items-center justify-end gap-3 px-5 py-4">
          {state === 'done' && diffs.length > 0 && (
            <button
              onClick={insertAll}
              style={{ color: 'var(--text-muted)' }}
              className="text-sm hover:opacity-70 transition-opacity mr-auto"
            >
              Insert all
            </button>
          )}
          <button
            onClick={onClose}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
