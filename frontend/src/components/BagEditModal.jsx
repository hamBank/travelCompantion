import { useState } from 'react'

/** Descendant bag ids of `bagId` (so they can't be offered as its parent). */
export function descendantIds(bagId, bags) {
  const out = new Set()
  const walk = id => {
    for (const b of bags) {
      if (b.parent_id === id && !out.has(b.id)) { out.add(b.id); walk(b.id) }
    }
  }
  walk(bagId)
  return out
}

export default function BagEditModal({ bag, bags, onSave, onDelete, onClose }) {
  const [name, setName] = useState(bag.name)
  const [parentId, setParentId] = useState(bag.parent_id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // A bag can't be inside itself or any of its descendants.
  const blocked = descendantIds(bag.id, bags)
  blocked.add(bag.id)
  const parentChoices = bags.filter(b => !blocked.has(b.id))

  async function save() {
    if (!name.trim() || busy) return
    setBusy(true); setError(null)
    try {
      await onSave(bag.id, { name: name.trim(), parent_id: parentId ? Number(parentId) : null })
      onClose()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)' }} className="w-full max-w-sm rounded-2xl overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">Edit bag</span>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-sm hover:opacity-70">✕</button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <label className="block">
            <span style={{ color: 'var(--text-muted)' }} className="text-xs">Name</span>
            <input
              value={name} onChange={e => setName(e.target.value)} autoFocus
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
              className="w-full text-sm px-2.5 py-1.5 rounded-lg mt-0.5"
            />
          </label>
          <label className="block">
            <span style={{ color: 'var(--text-muted)' }} className="text-xs">Inside bag</span>
            <select
              value={parentId} onChange={e => setParentId(e.target.value)}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
              className="w-full text-sm px-2.5 py-1.5 rounded-lg mt-0.5"
            >
              <option value="">Top level (no parent)</option>
              {parentChoices.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}
        </div>

        <div className="px-4 py-3 flex items-center justify-between" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => { if (confirm(`Delete bag "${bag.name}"? Items become unassigned and sub-bags move up a level.`)) { onDelete(bag.id); onClose() } }}
            style={{ color: 'var(--error)' }} className="text-xs hover:opacity-70"
          >Delete</button>
          <div className="flex gap-2">
            <button onClick={onClose} style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }} className="text-xs px-3 py-1.5 rounded-lg hover:opacity-80">Cancel</button>
            <button onClick={save} disabled={busy} style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }} className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
