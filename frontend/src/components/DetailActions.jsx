import { useState } from 'react'
import { deleteItem } from '../api.js'

/**
 * Shared footer for detail modals — Edit + Delete actions with inline
 * delete confirmation. Renders nothing unless onEdit or onDeleted is given.
 *
 * Props:
 *   item       — the item being viewed
 *   onEdit     — called when Edit is clicked (e.g. close detail, open edit modal)
 *   onDeleted  — called with item.id after a successful delete
 *   onClose    — called to close the detail modal after delete
 */
export default function DetailActions({ item, onEdit, onDeleted, onClose }) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)

  if (!onEdit && !onDeleted) return null

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
          {error && <span style={{ color: 'var(--error)' }} className="text-xs flex-1">{error}</span>}
          {!error && <div className="flex-1" />}
          {onDeleted && (
            <button
              onClick={() => setConfirming(true)}
              style={{ color: 'var(--error)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)' }}
              className="px-3 py-1.5 rounded-lg text-sm font-medium hover:opacity-80 transition-opacity"
            >
              Delete
            </button>
          )}
          {onEdit && (
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
