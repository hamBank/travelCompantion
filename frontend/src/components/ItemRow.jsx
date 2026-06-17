import { useState } from 'react'
import { updateItemStatus } from '../api.js'

const CYCLE = { pending: 'done', done: 'skipped', skipped: 'pending' }
const ICON = { pending: '○', done: '✓', skipped: '—' }

export default function ItemRow({ item }) {
  const [status, setStatus] = useState(item.status)

  async function cycle() {
    const next = CYCLE[status]
    setStatus(next)
    try { await updateItemStatus(item.id, next) }
    catch { setStatus(status) }
  }

  const struck = status === 'skipped'
  const iconColor = status === 'done'
    ? 'var(--success)'
    : status === 'skipped'
      ? 'var(--text-faint)'
      : 'var(--text-faint)'

  return (
    <div className="flex items-start gap-3 py-0.5">
      <button
        onClick={cycle}
        style={{ color: iconColor, marginTop: '1px', minWidth: '1rem' }}
        className="text-sm hover:opacity-70 transition-opacity shrink-0"
      >
        {ICON[status]}
      </button>
      <div className="flex-1 min-w-0 text-sm" style={{ opacity: struck ? 0.4 : 1 }}>
        {item.notes && (
          <span style={{ color: 'var(--text-faint)' }} className="text-xs mr-2">{item.notes}</span>
        )}
        {item.link
          ? <a href={item.link} target="_blank" rel="noreferrer"
              style={{ color: 'var(--text)' }} className="hover:opacity-70 transition-opacity">
              {item.name}
            </a>
          : <span style={{ color: 'var(--text)' }}>{item.name}</span>
        }
        {item.cost && (
          <span style={{ color: 'var(--text-muted)' }} className="text-xs ml-2">{item.cost}</span>
        )}
      </div>
    </div>
  )
}
