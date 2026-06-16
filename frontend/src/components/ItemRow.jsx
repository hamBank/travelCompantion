import { useState } from 'react'
import { updateItemStatus } from '../api.js'

const CYCLE = { pending: 'done', done: 'skipped', skipped: 'pending' }
const ICON = { pending: '○', done: '✓', skipped: '—' }
const ICON_COLOR = { pending: '#6c7086', done: '#a6e3a1', skipped: '#6c7086' }

export default function ItemRow({ item }) {
  const [status, setStatus] = useState(item.status)

  async function cycle() {
    const next = CYCLE[status]
    setStatus(next)
    try { await updateItemStatus(item.id, next) }
    catch { setStatus(status) }
  }

  const struck = status === 'skipped'

  return (
    <div className="flex items-start gap-3 py-0.5">
      <button
        onClick={cycle}
        style={{ color: ICON_COLOR[status], marginTop: '1px', minWidth: '1rem' }}
        className="text-sm hover:opacity-70 transition-opacity shrink-0"
      >
        {ICON[status]}
      </button>
      <div className="flex-1 min-w-0 text-sm" style={{ opacity: struck ? 0.45 : 1 }}>
        {item.notes && (
          <span style={{ color: '#6c7086' }} className="text-xs mr-2">{item.notes}</span>
        )}
        {item.link
          ? <a href={item.link} target="_blank" rel="noreferrer"
              style={{ color: '#cdd6f4' }} className="hover:text-[#cba6f7] transition-colors">
              {item.name}
            </a>
          : <span style={{ color: '#cdd6f4' }}>{item.name}</span>
        }
        {item.cost && (
          <span style={{ color: '#9399b2' }} className="text-xs ml-2">{item.cost}</span>
        )}
      </div>
    </div>
  )
}
