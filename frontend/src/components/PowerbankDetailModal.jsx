import { useEffect } from 'react'
import { getPowerbankPolicy } from '../powerbank.js'

/** Full power bank policy detail behind FlightDetailModal's one-line summary. */
export default function PowerbankDetailModal({ airline, onClose }) {
  const p = getPowerbankPolicy(airline)
  const rows = [
    ['Max capacity', p.maxWh],
    ['Permitted',    p.number],
    ['Storage',      p.storage],
    ['In-flight use', p.usage],
  ]

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
          maxWidth: '26rem',
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
          <div className="font-semibold text-sm">🔋 Power bank policy</div>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-faint)' }}
            className="text-lg leading-none hover:opacity-70 shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1">
          <div className="flex items-center justify-between mb-2">
            <span style={{ color: 'var(--text-faint)' }} className="text-xs">{p.source}</span>
          </div>
          <div className="space-y-1.5">
            {rows.map(([label, value]) => (
              <div key={label} className="flex gap-3 text-sm">
                <span style={{ color: 'var(--text-faint)', minWidth: '6.5rem' }} className="shrink-0">{label}</span>
                <span style={{ color: 'var(--text)' }} className="flex-1">{value}</span>
              </div>
            ))}
          </div>
          <p style={{ color: 'var(--text-faint)' }} className="text-xs pt-3 italic">
            Rules change frequently — confirm with the airline before travel.
          </p>
        </div>
      </div>
    </div>
  )
}
