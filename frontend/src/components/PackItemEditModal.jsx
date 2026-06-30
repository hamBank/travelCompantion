import { useState } from 'react'

/**
 * Edit a single packing item: name, quantity, packed count, bag, and (for
 * editors) shared. Quantity/packed are now editable here — the inline row only
 * does quick toggles.
 */
export default function PackItemEditModal({ item, bags, canEdit, onSave, onDelete, onClose }) {
  const [name, setName] = useState(item.name)
  const [quantity, setQuantity] = useState(item.quantity)
  const [packed, setPacked] = useState(item.packed_count)
  const [bagId, setBagId] = useState(item.bag_id ?? '')
  const [shared, setShared] = useState(!item.owner_email)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const qNum = Math.max(1, Number(quantity) || 1)
  const pNum = Math.max(0, Math.min(Number(packed) || 0, qNum))

  async function save() {
    if (!name.trim() || busy) return
    setBusy(true); setError(null)
    const body = { name: name.trim(), quantity: qNum, packed_count: pNum, bag_id: bagId ? Number(bagId) : null }
    if (canEdit) body.shared = shared
    try { await onSave(item.id, body); onClose() }
    catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)' }}
        className="w-full max-w-sm rounded-2xl overflow-hidden"
      >
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">Edit item</span>
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

          <div className="flex gap-3">
            <label className="flex-1">
              <span style={{ color: 'var(--text-muted)' }} className="text-xs">Quantity</span>
              <input
                type="number" min="1" value={quantity}
                onChange={e => { setQuantity(e.target.value); const q = Math.max(1, Number(e.target.value) || 1); if (Number(packed) > q) setPacked(q) }}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                className="w-full text-sm px-2.5 py-1.5 rounded-lg mt-0.5"
              />
            </label>
            <label className="flex-1">
              <span style={{ color: 'var(--text-muted)' }} className="text-xs">Packed</span>
              <input
                type="number" min="0" max={qNum} value={packed} onChange={e => setPacked(e.target.value)}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                className="w-full text-sm px-2.5 py-1.5 rounded-lg mt-0.5"
              />
            </label>
          </div>

          <label className="block">
            <span style={{ color: 'var(--text-muted)' }} className="text-xs">Bag</span>
            <select
              value={bagId} onChange={e => setBagId(e.target.value)}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
              className="w-full text-sm px-2.5 py-1.5 rounded-lg mt-0.5"
            >
              <option value="">No bag</option>
              {bags.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>

          {canEdit && (
            <label style={{ color: 'var(--text-muted)' }} className="text-xs flex items-center gap-2 select-none">
              <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
              Shared (visible to everyone on the trip)
            </label>
          )}

          {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}
        </div>

        <div className="px-4 py-3 flex items-center justify-between" style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={() => { if (confirm(`Remove "${item.name}"?`)) { onDelete(item.id); onClose() } }}
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
