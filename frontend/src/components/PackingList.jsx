import { useState, useEffect } from 'react'
import {
  getPacking, createPackItem, updatePackItem, deletePackItem,
  createBag, updateBag, deleteBag,
} from '../api.js'

export const isPacked = (it) => it.packed_count >= it.quantity && it.quantity > 0
export const isShared = (it) => !it.owner_email

const NO_BAG = '__nobag__'

export default function PackingList({ tripId, userEmail, canEdit }) {
  const [data, setData] = useState({ bags: [], items: [], counts: { total: 0, packed: 0 } })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [name, setName] = useState('')
  const [qty, setQty] = useState(1)
  const [shared, setShared] = useState(false)
  const [bagId, setBagId] = useState('')
  const [newBagName, setNewBagName] = useState('')

  async function load() {
    try { setData(await getPacking(tripId)) }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [tripId])

  const { bags, items, counts } = data

  async function addItem(e) {
    e.preventDefault()
    if (!name.trim()) return
    await createPackItem(tripId, {
      name: name.trim(), quantity: Math.max(1, Number(qty) || 1),
      shared, bag_id: bagId ? Number(bagId) : null,
    })
    setName(''); setQty(1)
    load()
  }

  async function patch(id, body) { await updatePackItem(id, body); load() }
  async function toggle(it)  { await patch(it.id, { packed_count: isPacked(it) ? 0 : it.quantity }) }
  async function step(it, d) { await patch(it.id, { packed_count: it.packed_count + d }) }
  async function remove(id)  { await deletePackItem(id); load() }

  async function addBag(e) {
    e.preventDefault()
    if (!newBagName.trim()) return
    await createBag(tripId, newBagName.trim())
    setNewBagName(''); load()
  }
  async function renameBag(bag) {
    const n = prompt('Rename bag', bag.name)
    if (n && n.trim() && n !== bag.name) { await updateBag(bag.id, n.trim()); load() }
  }
  async function removeBag(bag) {
    if (confirm(`Delete bag "${bag.name}"? Items in it become unassigned.`)) { await deleteBag(bag.id); load() }
  }

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading packing list…</p>
  if (error)   return <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>

  // Group items by bag (preserving bag order; unassigned last).
  const groups = [...bags.map(b => ({ key: String(b.id), bag: b })), { key: NO_BAG, bag: null }]
  const byBag = id => items.filter(i => (i.bag_id == null ? NO_BAG : String(i.bag_id)) === id)
  const pct = counts.total ? Math.round((counts.packed / counts.total) * 100) : 0

  return (
    <div className="max-w-3xl mx-auto">
      {/* Summary */}
      <div className="mb-4">
        <div className="flex items-baseline justify-between mb-1">
          <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">Packing</span>
          <span style={{ color: 'var(--text-faint)' }} className="text-xs">
            {counts.packed} / {counts.total} packed{counts.total ? ` · ${pct}%` : ''}
          </span>
        </div>
        <div style={{ background: 'var(--surface-2)', borderRadius: '999px', height: '6px' }}>
          <div style={{ width: `${pct}%`, background: 'var(--accent)', height: '100%', borderRadius: '999px', transition: 'width .2s' }} />
        </div>
      </div>

      {/* Add item */}
      <form onSubmit={addItem} className="flex flex-wrap items-center gap-2 mb-5">
        <input
          value={name} onChange={e => setName(e.target.value)} placeholder="Add item…"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
          className="flex-1 min-w-[8rem] text-sm px-2.5 py-1.5 rounded-lg"
        />
        <input
          type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} title="Quantity"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', width: '3.5rem' }}
          className="text-sm px-2 py-1.5 rounded-lg"
        />
        <select
          value={bagId} onChange={e => setBagId(e.target.value)} title="Bag"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
          className="text-sm px-2 py-1.5 rounded-lg"
        >
          <option value="">No bag</option>
          {bags.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {canEdit && (
          <label style={{ color: 'var(--text-muted)' }} className="text-xs flex items-center gap-1 select-none" title="Visible to everyone on the trip">
            <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} /> shared
          </label>
        )}
        <button
          type="submit"
          style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
          className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80"
        >Add</button>
      </form>

      {/* Bag groups */}
      {groups.map(({ key, bag }) => {
        const list = byBag(key)
        if (key === NO_BAG && list.length === 0) return null
        const bp = list.reduce((a, i) => a + i.packed_count, 0)
        const bt = list.reduce((a, i) => a + i.quantity, 0)
        return (
          <div key={key} className="mb-4">
            <div className="flex items-center gap-2 mb-1.5">
              <span style={{ color: 'var(--text-muted)' }} className="text-xs font-semibold uppercase tracking-wide">
                {bag ? `🧳 ${bag.name}` : 'No bag'}
              </span>
              <span style={{ color: 'var(--text-faint)' }} className="text-xs">{bp}/{bt}</span>
              {bag && canEdit && (
                <span className="flex gap-1.5 ml-1">
                  <button onClick={() => renameBag(bag)} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70" title="Rename">✎</button>
                  <button onClick={() => removeBag(bag)} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70" title="Delete">🗑</button>
                </span>
              )}
            </div>
            {list.length === 0
              ? <p style={{ color: 'var(--text-faint)' }} className="text-xs pl-1 py-1">Empty</p>
              : list.map(it => <PackRow key={it.id} it={it} bags={bags} onToggle={toggle} onStep={step} onRemove={remove} onPatch={patch} canEdit={canEdit} />)}
          </div>
        )
      })}

      {/* Add bag */}
      {canEdit && (
        <form onSubmit={addBag} className="flex items-center gap-2 mt-6">
          <input
            value={newBagName} onChange={e => setNewBagName(e.target.value)} placeholder="Add a bag…"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
            className="text-sm px-2.5 py-1.5 rounded-lg"
          />
          <button type="submit" style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }} className="text-xs px-3 py-1.5 rounded-lg hover:opacity-80">+ Bag</button>
        </form>
      )}
    </div>
  )
}

function PackRow({ it, bags, onToggle, onStep, onRemove, onPatch, canEdit }) {
  const packed = isPacked(it)
  const shared = isShared(it)
  return (
    <div
      className="flex items-center gap-2 py-1.5 group"
      style={shared ? { borderLeft: '2px solid var(--accent)', paddingLeft: '0.5rem' } : { paddingLeft: 'calc(0.5rem + 2px)' }}
    >
      <input type="checkbox" checked={packed} onChange={() => onToggle(it)} />
      <span
        className="text-sm flex-1 min-w-0 truncate"
        style={{ color: packed ? 'var(--text-faint)' : 'var(--text)', textDecoration: packed ? 'line-through' : 'none' }}
      >
        {it.name}
      </span>
      {shared && (
        <span style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', fontSize: '0.6rem' }}
              className="px-1.5 py-0.5 rounded uppercase tracking-wide font-medium shrink-0">Shared</span>
      )}
      {it.quantity > 1 && (
        <span className="flex items-center gap-1 shrink-0" style={{ color: 'var(--text-faint)' }}>
          <button onClick={() => onStep(it, -1)} className="text-xs hover:opacity-70 px-1" title="Pack one less">−</button>
          <span className="text-xs tabular-nums">{it.packed_count}/{it.quantity}</span>
          <button onClick={() => onStep(it, 1)} className="text-xs hover:opacity-70 px-1" title="Pack one more">+</button>
        </span>
      )}
      <select
        value={it.bag_id ?? ''} onChange={e => onPatch(it.id, { bag_id: e.target.value ? Number(e.target.value) : null })}
        title="Move to bag"
        style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-faint)', fontSize: '0.7rem' }}
        className="rounded px-1 py-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <option value="">No bag</option>
        {bags.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <button onClick={() => onRemove(it.id)} style={{ color: 'var(--text-faint)' }}
              className="text-xs shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity" title="Remove">✕</button>
    </div>
  )
}
