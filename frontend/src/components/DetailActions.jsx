import { useState } from 'react'
import { History, Check } from 'lucide-react'
import { deleteItem, updateItemStatus } from '../api.js'
import { offlineQueue } from '../offlineQueue.js'
import { useCanEdit, useCanQueueEdit } from '../roles.js'

/**
 * Shared footer for detail modals — History + status toggle + Edit + Delete.
 *
 * Props:
 *   item           — the item being viewed
 *   onEdit         — called when Edit is clicked (editors only)
 *   onDeleted      — called with item.id after a successful delete (editors only)
 *   onClose        — called to close the detail modal after delete
 *   onHistory      — called to open the history modal (all users)
 *   onStatusChange — called with the updated item after Mark done/pending
 *                    succeeds. The collapsed card's leading icon already
 *                    toggles pending/done, but that's easy to miss — this
 *                    gives the same control a home inside the detail view.
 */
export default function DetailActions({ item, onEdit, onDeleted, onClose, onHistory, onStatusChange }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const [error, setError] = useState(null)

  const canEdit = useCanEdit()
  // Edit (unlike Delete) is queueable offline for a real editor — see
  // ItemEditModal's Save, which routes through the offline queue.
  const canQueueEdit = useCanQueueEdit()
  const canEditOrQueue = canEdit || canQueueEdit
  const done = item.status === 'done'

  // Render nothing if there's nothing to show.
  if (!onHistory && !canEditOrQueue) return null
  if (!onHistory && !onEdit && !onDeleted && !onStatusChange) return null

  async function handleDelete() {
    setDeleting(true); setError(null)
    try {
      await deleteItem(item.id)
      onDeleted?.(item.id)
      onClose?.()
    } catch (e) {
      setError(e.message)
      setDeleting(false)
    }
  }

  async function toggleStatus() {
    if (statusBusy || !canEditOrQueue) return
    setStatusBusy(true); setError(null)
    const next = done ? 'pending' : 'done'
    try {
      // Same online/offline branching as the collapsed card's icon toggle
      // (StopCard.jsx's CardIcon) — canQueueEdit is only ever true offline.
      if (canQueueEdit) {
        await offlineQueue.enqueue({ entity: 'item', entityId: item.id, changes: { status: next }, base: { status: item.status } })
      } else {
        await updateItemStatus(item.id, next)
      }
      onStatusChange?.({ ...item, status: next })
    } catch (e) {
      setError(e.message)
    } finally {
      setStatusBusy(false)
    }
  }

  return (
    <div
      style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-2)' }}
      className="px-5 py-3 flex items-center gap-3 sticky bottom-0"
    >
      {confirming ? (
        <>
          <span style={{ color: 'var(--text)' }} className="text-sm flex-1">Delete this item?</span>
          <button
            onClick={() => setConfirming(false)}
            disabled={deleting}
            style={{ color: 'var(--text-faint)' }}
            className="text-sm hover:opacity-70 transition-opacity"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{ background: 'var(--error)', color: '#fff' }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </>
      ) : (
        <>
          {onHistory && (
            <button
              onClick={onHistory}
              style={{ color: 'var(--text-faint)' }}
              className="text-sm hover:opacity-70 transition-opacity"
              title="Change history"
            >
              <History size={13} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.3em' }} />History
            </button>
          )}
          {error && <span style={{ color: 'var(--error)' }} className="text-xs flex-1">{error}</span>}
          {!error && <div className="flex-1" />}
          {canEditOrQueue && onStatusChange && (
            <button
              onClick={toggleStatus}
              disabled={statusBusy}
              style={{
                color: done ? 'var(--text-faint)' : 'var(--success)',
                border: `1px solid color-mix(in srgb, ${done ? 'var(--text-faint)' : 'var(--success)'} 35%, transparent)`,
              }}
              className="px-3 py-1.5 rounded-lg text-sm font-medium hover:opacity-80 transition-opacity disabled:opacity-50 flex items-center gap-1"
              title={done ? 'Mark as not done' : 'Mark as done'}
            >
              <Check size={13} aria-hidden="true" />
              {statusBusy ? '…' : (done ? 'Mark pending' : 'Mark done')}
            </button>
          )}
          {canEdit && onDeleted && (
            <button
              onClick={() => setConfirming(true)}
              style={{ color: 'var(--error)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)' }}
              className="px-3 py-1.5 rounded-lg text-sm font-medium hover:opacity-80 transition-opacity"
            >
              Delete
            </button>
          )}
          {canEditOrQueue && onEdit && (
            <button
              onClick={onEdit}
              style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
              className="px-4 py-1.5 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Edit
            </button>
          )}
        </>
      )}
    </div>
  )
}
