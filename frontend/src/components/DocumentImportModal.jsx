import { useState } from 'react'
import { parseDocument } from '../api.js'

export default function DocumentImportModal({ tripId, onClose, onParsed }) {
  const [stage, setStage]     = useState('pick')   // pick | parsing
  const [pending, setPending] = useState([])        // selected but not yet submitted
  const [error, setError]     = useState(null)

  function handleSelect(e) {
    const chosen = Array.from(e.target.files || [])
    e.target.value = ''
    if (!chosen.length) return
    setPending(prev => {
      const existing = new Set(prev.map(f => f.name + f.size))
      return [...prev, ...chosen.filter(f => !existing.has(f.name + f.size))]
    })
    setError(null)
  }

  function removeFile(idx) {
    setPending(prev => prev.filter((_, i) => i !== idx))
  }

  async function submit() {
    if (!pending.length) return
    setError(null); setStage('parsing')
    try {
      const result = await parseDocument(tripId, pending)
      onParsed?.(result)
    } catch (err) {
      setError(err.message)
      setStage('pick')
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
        className="rounded-xl w-full max-w-md p-5"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ color: 'var(--text)' }} className="font-semibold text-base">Import from document</h2>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-lg leading-none hover:opacity-70">✕</button>
        </div>

        {error && <p style={{ color: 'var(--error)' }} className="text-xs mb-3">{error}</p>}

        {stage === 'pick' && (
          <>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs mb-4">
              Upload booking emails (.eml), ticket PDFs, or text files. Multiple files are processed
              together — useful when each passenger has a separate e-ticket.
            </p>

            <label
              style={{ color: 'var(--accent)', border: '1px dashed color-mix(in srgb, var(--accent) 40%, transparent)', background: 'color-mix(in srgb, var(--accent) 6%, transparent)' }}
              className="block text-center text-sm px-4 py-5 rounded-lg cursor-pointer hover:opacity-80 transition-opacity mb-3"
            >
              {pending.length ? 'Add more files…' : 'Choose files…'}
              <input
                type="file"
                multiple
                accept=".eml,.pdf,.txt,.md,.html,.htm,message/rfc822,application/pdf,text/plain"
                onChange={handleSelect}
                className="hidden"
              />
            </label>

            {pending.length > 0 && (
              <div className="space-y-1.5 mb-4">
                {pending.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span className="flex-1 truncate">{f.name}</span>
                    <span style={{ color: 'var(--text-faint)' }}>
                      {f.size < 1024 ? `${f.size}B` : f.size < 1048576 ? `${(f.size/1024).toFixed(0)}KB` : `${(f.size/1048576).toFixed(1)}MB`}
                    </span>
                    <button
                      onClick={() => removeFile(i)}
                      style={{ color: 'var(--error)' }}
                      className="hover:opacity-70 shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {pending.length > 0 && (
              <button
                onClick={submit}
                style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                className="w-full py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Process {pending.length} file{pending.length !== 1 ? 's' : ''}
              </button>
            )}
          </>
        )}

        {stage === 'parsing' && (
          <p style={{ color: 'var(--text-muted)' }} className="text-sm text-center py-8">
            Reading & extracting{pending.length > 1 ? ` ${pending.length} files` : ''}…
          </p>
        )}
      </div>
    </div>
  )
}
