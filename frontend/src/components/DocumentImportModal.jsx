import { useState } from 'react'
import { parseDocument } from '../api.js'

// Pick a document, parse it, and hand the result off to the pending-review UI.
// The parsed item is persisted server-side as a PendingChange; review/apply
// happens in PendingReview, not here.
export default function DocumentImportModal({ tripId, onClose, onParsed }) {
  const [stage, setStage] = useState('pick') // pick | parsing
  const [error, setError] = useState(null)

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null); setStage('parsing')
    try {
      const result = await parseDocument(tripId, file)
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
              Upload a booking email (.eml), ticket PDF, or text file. It'll be read, classified,
              matched to a stop, and added to your pending imports to review before it's saved.
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
      </div>
    </div>
  )
}
