import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { updateItemStatus } from '../api.js'
import ItemDetailModal from './ItemDetailModal.jsx'
import ItemEditModal from './ItemEditModal.jsx'
import CostDisplay from './CostDisplay.jsx'
import { isFullyPaid } from '../currency.js'
import { fmtDayTime } from '../dates.js'

const CYCLE = { pending: 'done', done: 'skipped', skipped: 'pending' }
const ICON = { pending: '○', done: '✓', skipped: '—' }

/**
 * @deprecated FALLBACK ONLY. Every known item kind now has its own boxed card in
 * StopCard.jsx. If this row ever renders it means an item kind is unhandled —
 * add a dedicated card for `item.kind` rather than relying on this. The visible
 * "⚠ unsupported type" badge below is intentional so the gap is obvious in the UI.
 */
export default function ItemRow({ item, onItemSaved, onItemDeleted }) {
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
      <div className="flex items-center gap-3 group" style={{ minHeight: '1.75rem' }}>
        <button
          onClick={cycle}
          style={{ color: iconColor, minWidth: '1rem' }}
          className="text-sm hover:opacity-70 transition-opacity shrink-0"
        >
          {ICON[status]}
        </button>
        <button
          onClick={() => setShowDetail(true)}
          className="flex-1 min-w-0 text-left hover:opacity-70 transition-opacity flex items-center gap-2"
          style={{ opacity: struck ? 0.4 : 1 }}
        >
          <span
            title={`Unsupported item type "${current.kind}" — add a dedicated card`}
            style={{
              color: 'var(--warning)',
              border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
              fontSize: '0.6rem',
            }}
            className="shrink-0 px-1.5 py-0.5 rounded uppercase tracking-wide font-medium"
          >
            ⚠ deprecated
          </span>
          <span className="text-sm truncate" style={{ color: 'var(--text)' }}>
            {current.name}
          </span>
          {current.cost && !isFullyPaid(current) && (
            <CostDisplay item={current} className="text-xs shrink-0" style={{ color: 'var(--text-muted)' }} compact />
          )}
          {current.scheduled_at && (
            <span style={{ color: 'var(--text-faint)' }} className="text-xs shrink-0 ml-auto">
              {fmtDayTime(current.scheduled_at)}
            </span>
          )}
        </button>
        <button
          onClick={e => { e.stopPropagation(); setShowEdit(true) }}
          style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}
          className="edit-btn shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity"
          title="Edit"
          aria-label="Edit"
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
      </div>
      {showDetail && (
        <ItemDetailModal
          item={current}
          onClose={() => setShowDetail(false)}
          onEdit={() => { setShowDetail(false); setShowEdit(true) }}
          onDeleted={onItemDeleted}
        />
      )}
      {showEdit && (
        <ItemEditModal
          item={current}
          onSave={updated => { setCurrent(updated); onItemSaved?.(updated); setShowEdit(false) }}
          onClose={() => setShowEdit(false)}
          onDeleted={onItemDeleted}
        />
      )}
    </>
  )
}
