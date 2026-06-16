import { useState } from 'react'
import { updateItem, deleteItem, createItem } from '../api.js'

const KIND_OPTIONS = ['activity', 'restaurant', 'note']

function Field({ label, value, onChange, placeholder, type = 'text' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label style={{ color: '#6c7086' }} className="text-xs">{label}</label>
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #313244' }}
        className="rounded px-2 py-1.5 text-sm outline-none focus:border-[#cba6f7]"
      />
    </div>
  )
}

function EditItemRow({ item, onDelete }) {
  const [fields, setFields] = useState({
    name: item.name,
    kind: item.kind,
    link: item.link ?? '',
    cost: item.cost ?? '',
    notes: item.notes ?? '',
  })
  const [saved, setSaved] = useState(true)
  const [busy, setBusy] = useState(false)

  function set(key, val) {
    setFields(f => ({ ...f, [key]: val }))
    setSaved(false)
  }

  async function save() {
    if (saved || busy) return
    setBusy(true)
    try {
      await updateItem(item.id, fields)
      setSaved(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ background: '#1e1e2e', border: '1px solid #313244' }}
      className="rounded-lg p-3 space-y-2">
      <div className="flex gap-2 items-start">
        <select
          value={fields.kind}
          onChange={e => set('kind', e.target.value)}
          style={{ background: '#1e1e2e', color: '#9399b2', border: '1px solid #313244' }}
          className="rounded px-2 py-1.5 text-xs outline-none focus:border-[#cba6f7]"
        >
          {KIND_OPTIONS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          value={fields.name}
          onChange={e => set('name', e.target.value)}
          onBlur={save}
          placeholder="Name"
          style={{ background: 'transparent', color: '#cdd6f4', border: 'none', borderBottom: '1px solid #313244' }}
          className="flex-1 text-sm px-1 py-1 outline-none focus:border-[#cba6f7]"
        />
        <button
          onClick={onDelete}
          style={{ color: '#6c7086' }}
          className="text-xs hover:text-[#f38ba8] transition-colors shrink-0"
        >
          ✕
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Notes / time" value={fields.notes} onChange={v => set('notes', v)} placeholder="e.g. 9:00" />
        <Field label="Link" value={fields.link} onChange={v => set('link', v)} placeholder="https://…" />
        <Field label="Cost" value={fields.cost} onChange={v => set('cost', v)} placeholder="€20" />
      </div>
      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={saved || busy}
          style={{ color: saved ? '#6c7086' : '#cba6f7' }}
          className="text-xs disabled:opacity-50 hover:opacity-70 transition-opacity"
        >
          {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save item'}
        </button>
      </div>
    </div>
  )
}

export default function EditItemsSection({ stopId, items, onRefresh }) {
  const [adding, setAdding] = useState(false)
  const [newItem, setNewItem] = useState({ kind: 'activity', name: '' })
  const [error, setError] = useState(null)

  async function handleAdd() {
    if (!newItem.name.trim()) return
    setAdding(true); setError(null)
    try {
      await createItem(stopId, { ...newItem, status: 'pending' })
      setNewItem({ kind: 'activity', name: '' })
      onRefresh()
    } catch (e) { setError(e.message) }
    finally { setAdding(false) }
  }

  async function handleDelete(id) {
    try { await deleteItem(id); onRefresh() }
    catch (e) { setError(e.message) }
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <EditItemRow key={item.id} item={item} onDelete={() => handleDelete(item.id)} />
      ))}

      {error && <p style={{ color: '#f38ba8' }} className="text-xs">{error}</p>}

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
    </div>
  )
}
