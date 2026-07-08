import { useState } from 'react'
import { deleteItem } from '../api.js'
import { useCanEdit, useCanQueueEdit } from '../roles.js'

/**
 * Shared footer for detail modals — History + Edit + Delete actions.
 *
 * Props:
 *   item       — the item being viewed
 *   onEdit     — called when Edit is clicked (editors only)
 *   onDeleted  — called with item.id after a successful delete (editors only)
 *   onClose    — called to close the detail modal after delete
 *   onHistory  — called to open the history modal (all users)
 */
export default function DetailActions({ item, onEdit, onDeleted, onClose, onHistory }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)

  const canEdit = useCanEdit()
  // Edit (unlike Delete) is queueable offline for a real editor — see
  // ItemEditModal's Save, which routes through the offline queue.
  const canQueueEdit = useCanQueueEdit()
  const canEditOrQueue = canEdit || canQueueEdit

  // Render nothing if there's nothing to show.
  if (!onHistory && !canEditOrQueue) return null
  if (!onHistory && !onEdit && !onDeleted) return null

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
              🕐 History
            </button>
          )}
          {error && <span style={{ color: 'var(--error)' }} className="text-xs flex-1">{error}</span>}
          {!error && <div className="flex-1" />}
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
