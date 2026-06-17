import { useState } from 'react'
import { updateItemStatus } from '../api.js'
import ItemDetailModal from './ItemDetailModal.jsx'

const CYCLE = { pending: 'done', done: 'skipped', skipped: 'pending' }
const ICON = { pending: '○', done: '✓', skipped: '—' }

export default function ItemRow({ item }) {
  const [status, setStatus] = useState(item.status)
  const [showDetail, setShowDetail] = useState(false)

  async function cycle(e) {
    e.stopPropagation()
    const next = CYCLE[status]
    setStatus(next)
    try { await updateItemStatus(item.id, next) }
    catch { setStatus(status) }
  }

  const struck = status === 'skipped'
  const iconColor = status === 'done' ? 'var(--success)' : 'var(--text-faint)'

  return (
    <>
      <div className="flex items-start gap-3 py-0.5">
        <button
          onClick={cycle}
          style={{ color: iconColor, marginTop: '1px', minWidth: '1rem' }}
          className="text-sm hover:opacity-70 transition-opacity shrink-0"
        >
          {ICON[status]}
        </button>
        <button
          onClick={() => setShowDetail(true)}
          className="flex-1 min-w-0 text-left hover:opacity-70 transition-opacity"
          style={{ opacity: struck ? 0.4 : 1 }}
        >
          <span className="text-sm" style={{ color: 'var(--text)' }}>
            {item.scheduled_at && (
              <span style={{ color: 'var(--text-faint)' }} className="text-xs mr-2">
                {new Date(item.scheduled_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            {item.name}
            {item.cost && (
              <span style={{ color: 'var(--text-muted)' }} className="text-xs ml-2">{item.cost}</span>
            )}
          </span>
        </button>
      </div>
      {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)} />}
    </>
  )
}
