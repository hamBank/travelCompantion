import { useState } from 'react'
import { updateItemStatus } from '../api.js'
import ItemDetailModal from './ItemDetailModal.jsx'
import ItemEditModal from './ItemEditModal.jsx'

const CYCLE = { pending: 'done', done: 'skipped', skipped: 'pending' }
const ICON = { pending: '○', done: '✓', skipped: '—' }

export default function ItemRow({ item, onItemSaved }) {
  const [current, setCurrent] = useState(item)
  const [status, setStatus] = useState(item.status)
  const [showDetail, setShowDetail] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

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
      <div className="flex items-start gap-3 py-0.5 group">
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
            {current.scheduled_at && (
              <span style={{ color: 'var(--text-faint)' }} className="text-xs mr-2">
                {(() => {
                  const [dp, tp] = current.scheduled_at.split('T')
                  const d = new Date(dp + 'T00:00:00')
                  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' })
                  const day = d.getDate()
                  const time = tp?.slice(0, 5)
                  return time ? `${weekday} ${day} ${time}` : `${weekday} ${day}`
                })()}
              </span>
            )}
            {current.kind === 'note' && (
              <span className="mr-1" style={{ fontSize: '0.8em' }}>📝</span>
            )}
            {current.name}
            {current.cost && (
              <span style={{ color: 'var(--text-muted)' }} className="text-xs ml-2">{current.cost}</span>
            )}
          </span>
        </button>
        <button
          onClick={e => { e.stopPropagation(); setShowEdit(true) }}
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem', marginTop: '2px' }}
          className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
          title="Edit"
        >
          ✎
        </button>
      </div>
      {showDetail && <ItemDetailModal item={current} onClose={() => setShowDetail(false)} />}
      {showEdit && (
        <ItemEditModal
          item={current}
          onSave={updated => { setCurrent(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
        />
      )}
    </>
  )
}
