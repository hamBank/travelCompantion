import { useState } from 'react'
import { deleteItem, createItem, uploadGpx } from '../api.js'
import ItemEditModal from './ItemEditModal.jsx'
import { KIND_VAR, KIND_OPTIONS } from '../kinds.js'
import { parseKmlRoutes, routeToGpx } from '../kml.js'

function itemSummary(item) {
  if (item.kind === 'accommodation') {
    const parts = [item.details?.checkin, item.details?.checkout].filter(Boolean)
    return parts.length ? parts.join(' → ') : (item.details?.location ?? '')
  }
  if (item.kind === 'flight') {
    const route = [item.details?.origin, item.details?.destination].filter(Boolean).join(' → ')
    return route || item.details?.flight_number || ''
  }
  return item.notes || item.cost || ''
}

function ItemRow({ item, onEdit, onDelete }) {
  const color = KIND_VAR[item.kind] ?? 'var(--text-muted)'
  const summary = itemSummary(item)

  return (
    <div
      style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
      className="rounded-lg px-3 py-2.5 flex items-center gap-2"
    >
      <span
        style={{
          color,
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
        }}
        className="text-xs px-1.5 py-0.5 rounded shrink-0"
      >
        {item.kind}
      </span>
      <span style={{ color: 'var(--text)' }} className="flex-1 text-sm min-w-0 truncate">{item.name}</span>
      {summary && (
        <span style={{ color: 'var(--text-faint)' }} className="text-xs truncate max-w-32 shrink-0">
          {summary}
        </span>
      )}
      <button
        onClick={onEdit}
        style={{ color: 'var(--text-faint)' }}
        className="text-xs shrink-0 ml-1 hover:opacity-70 transition-opacity"
        onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
      >
        Edit
      </button>
      <button
        onClick={onDelete}
        style={{ color: 'var(--text-faint)' }}
        className="text-xs shrink-0 hover:opacity-70 transition-opacity"
        onMouseEnter={e => e.currentTarget.style.color = 'var(--error)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
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
  const [importing, setImporting] = useState(null)

  async function handleKmlImport(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const routes = parseKmlRoutes(await file.text())
      if (!routes.length) { setError('No routes (line geometry) found in that KML.'); return }
      let done = 0
      for (const r of routes) {
        setImporting(`Importing ${done + 1}/${routes.length}: ${r.name}…`)
        const item = await createItem(stopId, { kind: 'cycling', name: r.name, status: 'pending' })
        const gpx = routeToGpx(r.name, r.points)
        const gpxFile = new File([gpx], `${r.name}.gpx`, { type: 'application/gpx+xml' })
        try { await uploadGpx(item.id, gpxFile) } catch (_) { /* item still created without stats */ }
        done++
      }
      onRefresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(null)
    }
  }

  async function handleAdd() {
    if (!newItem.name.trim()) return
    setAdding(true); setError(null)
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

  function handleSaved() { setEditingItem(null); onRefresh() }

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

      {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}

      <div style={{ border: '1px dashed var(--border)', borderRadius: '0.5rem' }} className="p-2 flex gap-2">
        <select
          value={newItem.kind}
          onChange={e => setNewItem(n => ({ ...n, kind: e.target.value }))}
          style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          className="rounded px-2 py-1 text-xs outline-none"
        >
          {KIND_OPTIONS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          value={newItem.name}
          onChange={e => setNewItem(n => ({ ...n, name: e.target.value }))}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="New item name…"
          style={{ background: 'transparent', color: 'var(--text)' }}
          className="flex-1 text-sm px-1 outline-none"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newItem.name.trim()}
          style={{ color: 'var(--accent)' }}
          className="text-xs disabled:opacity-40 hover:opacity-70 transition-opacity"
        >
          + Add
        </button>
      </div>

      <div className="flex items-center gap-2">
        <label
          style={{ color: 'var(--kind-cycling)', border: '1px solid color-mix(in srgb, var(--kind-cycling) 35%, transparent)', background: 'color-mix(in srgb, var(--kind-cycling) 8%, transparent)', cursor: importing ? 'default' : 'pointer', opacity: importing ? 0.5 : 1 }}
          className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 transition-opacity"
        >
          {importing ? 'Importing…' : 'Import routes (KML)'}
          <input type="file" accept=".kml,application/vnd.google-earth.kml+xml" onChange={handleKmlImport} disabled={!!importing} className="hidden" />
        </label>
        {importing && <span className="text-xs" style={{ color: 'var(--text-faint)' }}>{importing}</span>}
        {!importing && <span className="text-xs" style={{ color: 'var(--text-faint)' }}>each route → a cycling record</span>}
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
