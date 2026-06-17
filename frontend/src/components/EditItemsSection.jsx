import { useState } from 'react'
import { deleteItem, createItem } from '../api.js'
import ItemEditModal from './ItemEditModal.jsx'

const KIND_OPTIONS = ['activity', 'restaurant', 'note', 'accommodation']

const KIND_COLOR = {
  activity: '#89b4fa',
  restaurant: '#a6e3a1',
  note: '#f9e2af',
  accommodation: '#cba6f7',
}

function itemSummary(item) {
  if (item.kind === 'accommodation') {
    const parts = [item.details?.checkin, item.details?.checkout].filter(Boolean)
    return parts.length ? parts.join(' → ') : (item.details?.location ?? '')
  }
  return item.notes || item.cost || ''
}

function ItemRow({ item, onEdit, onDelete }) {
  const color = KIND_COLOR[item.kind] ?? '#9399b2'
  const summary = itemSummary(item)

  return (
    <div
      style={{ background: '#1e1e2e', border: '1px solid #313244' }}
      className="rounded-lg px-3 py-2.5 flex items-center gap-2"
    >
      <span
        style={{ color, background: `${color}18`, border: `1px solid ${color}35` }}
        className="text-xs px-1.5 py-0.5 rounded shrink-0"
      >
        {item.kind}
      </span>
      <span className="flex-1 text-sm min-w-0 truncate">{item.name}</span>
      {summary && (
        <span style={{ color: '#6c7086' }} className="text-xs truncate max-w-32 shrink-0">
          {summary}
        </span>
      )}
      <button
        onClick={onEdit}
        style={{ color: '#6c7086' }}
        className="text-xs hover:text-[#cba6f7] transition-colors shrink-0 ml-1"
      >
        Edit
      </button>
      <button
        onClick={onDelete}
        style={{ color: '#6c7086' }}
        className="text-xs hover:text-[#f38ba8] transition-colors shrink-0"
      >
        ✕
      </button>
    </div>
  )
}

export default function EditItemsSection({ stopId, items, onRefresh }) {
  const [editingItem, setEditingItem] = useState(null)
  const [adding, setAdding] = useState(false)
  const [newItem, setNewItem] = useState({ kind: 'activity', name: '' })
  const [error, setError] = useState(null)

  async function handleAdd() {
    if (!newItem.name.trim()) return
    setAdding(true)
    setError(null)
    try {
      await createItem(stopId, { ...newItem, status: 'pending' })
      setNewItem({ kind: 'activity', name: '' })
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setAdding(false)
    }
  }

  async function handleDelete(id) {
    try { await deleteItem(id); onRefresh() }
    catch (e) { setError(e.message) }
  }

  function handleSaved() {
    setEditingItem(null)
    onRefresh()
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <ItemRow
          key={item.id}
          item={item}
          onEdit={() => setEditingItem(item)}
          onDelete={() => handleDelete(item.id)}
        />
      ))}

      {error && <p style={{ color: '#f38ba8' }} className="text-xs">{error}</p>}

      {/* Add row */}
      <div style={{ border: '1px dashed #313244' }} className="rounded-lg p-2 flex gap-2">
        <select
          value={newItem.kind}
          onChange={e => setNewItem(n => ({ ...n, kind: e.target.value }))}
          style={{ background: '#1e1e2e', color: '#9399b2', border: '1px solid #313244' }}
          className="rounded px-2 py-1 text-xs outline-none"
        >
          {KIND_OPTIONS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          value={newItem.name}
          onChange={e => setNewItem(n => ({ ...n, name: e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="New item name…"
          style={{ background: 'transparent', color: '#cdd6f4' }}
          className="flex-1 text-sm px-1 outline-none"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newItem.name.trim()}
          style={{ color: '#cba6f7' }}
          className="text-xs disabled:opacity-40 hover:opacity-70 transition-opacity"
        >
          + Add
        </button>
      </div>

      {editingItem && (
        <ItemEditModal
          item={editingItem}
          onSave={handleSaved}
          onClose={() => setEditingItem(null)}
        />
      )}
    </div>
  )
}
