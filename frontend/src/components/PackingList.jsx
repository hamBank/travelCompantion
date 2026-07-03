import { useState, useEffect } from 'react'
import {
  getPacking, createPackItem, updatePackItem, deletePackItem,
  createBag, updateBag, deleteBag,
} from '../api.js'
import PackItemEditModal from './PackItemEditModal.jsx'
import BagEditModal from './BagEditModal.jsx'

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
  const [editItem, setEditItem] = useState(null)
  const [editBag, setEditBag] = useState(null)

  // Collapsed bag groups, persisted per trip so the layout sticks across reloads.
  const COLLAPSE_KEY = `tc-pack-collapsed-${tripId}`
  const [collapsed, setCollapsed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')) } catch { return new Set() }
  })
  function toggleCollapse(key) {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }

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
    await createBag(tripId, { name: newBagName.trim() })
    setNewBagName(''); load()
  }
  async function saveBag(id, data) { await updateBag(id, data); load() }
  async function removeBag(id)     { await deleteBag(id); load() }

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading packing list…</p>
  if (error)   return <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>

  // Bags nest via parent_id — render as a tree. Counts roll up the subtree.
  const childrenOf = id => bags.filter(b => b.parent_id === id)
  const itemsInBag = id => items.filter(i => i.bag_id === id)
  const noBagItems = items.filter(i => i.bag_id == null)
  const topBags = bags.filter(b => b.parent_id == null)
  function subtreeCounts(id) {
    let packed = 0, total = 0
    for (const i of itemsInBag(id)) { packed += i.packed_count; total += i.quantity }
    for (const c of childrenOf(id)) { const s = subtreeCounts(c.id); packed += s.packed; total += s.total }
    return { packed, total }
  }
  const pct = counts.total ? Math.round((counts.packed / counts.total) * 100) : 0

  function renderItems(list) {
    return list.map(it => (
      <PackRow key={it.id} it={it} bags={bags} onToggle={toggle} onStep={step}
               onRemove={remove} onPatch={patch} onEdit={setEditItem} canEdit={canEdit} />
    ))
  }

  function renderBag(bag, depth) {
    const kids = childrenOf(bag.id)
    const direct = itemsInBag(bag.id)
    const { packed, total } = subtreeCounts(bag.id)
    const isCollapsed = collapsed.has(String(bag.id))
    return (
      <div key={bag.id} className="mb-2" style={{ marginLeft: depth ? '1rem' : 0, borderLeft: depth ? '1px solid var(--border)' : 'none', paddingLeft: depth ? '0.5rem' : 0 }}>
        <div className="flex items-center gap-2 mb-1">
          <button onClick={() => toggleCollapse(String(bag.id))} className="flex items-center gap-2 hover:opacity-80 transition-opacity" title={isCollapsed ? 'Expand' : 'Collapse'}>
            <span style={{ color: 'var(--text-faint)', fontSize: '0.6rem', width: '0.7rem' }}>{isCollapsed ? '▸' : '▾'}</span>
            <span style={{ color: 'var(--text-muted)' }} className="text-xs font-semibold uppercase tracking-wide">🧳 {bag.name}</span>
            <span style={{ color: 'var(--text-faint)' }} className="text-xs">{packed}/{total}</span>
          </button>
          {canEdit && (
            <button onClick={() => setEditBag(bag)} style={{ color: 'var(--text-faint)' }} className="text-xs hover:opacity-70 ml-1" title="Edit bag">✎</button>
          )}
        </div>
        {!isCollapsed && (
          <div>
            {direct.length === 0 && kids.length === 0
              ? <p style={{ color: 'var(--text-faint)' }} className="text-xs pl-1 py-1">Empty</p>
              : <>{renderItems(direct)}{kids.map(k => renderBag(k, depth + 1))}</>}
          </div>
        )}
      </div>
    )
  }

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

      {/* Bag tree, then unassigned items */}
      {topBags.map(b => renderBag(b, 0))}
      {noBagItems.length > 0 && (() => {
        const isCollapsed = collapsed.has(NO_BAG)
        const bp = noBagItems.reduce((a, i) => a + i.packed_count, 0)
        const bt = noBagItems.reduce((a, i) => a + i.quantity, 0)
        return (
          <div className="mb-2">
            <button onClick={() => toggleCollapse(NO_BAG)} className="flex items-center gap-2 hover:opacity-80 transition-opacity mb-1" title={isCollapsed ? 'Expand' : 'Collapse'}>
              <span style={{ color: 'var(--text-faint)', fontSize: '0.6rem', width: '0.7rem' }}>{isCollapsed ? '▸' : '▾'}</span>
              <span style={{ color: 'var(--text-muted)' }} className="text-xs font-semibold uppercase tracking-wide">No bag</span>
              <span style={{ color: 'var(--text-faint)' }} className="text-xs">{bp}/{bt}</span>
            </button>
            {!isCollapsed && renderItems(noBagItems)}
          </div>
        )
      })()}

      {editItem && (
        <PackItemEditModal
          item={editItem} bags={bags} canEdit={canEdit}
          onSave={patch} onDelete={remove} onClose={() => setEditItem(null)}
        />
      )}
      {editBag && (
        <BagEditModal
          bag={editBag} bags={bags}
          onSave={saveBag} onDelete={removeBag} onClose={() => setEditBag(null)}
        />
      )}

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

function PackRow({ it, bags, onToggle, onStep, onRemove, onPatch, onEdit, canEdit }) {
  const packed = isPacked(it)
  const shared = isShared(it)
  const editable = !shared || canEdit   // own personal items always; shared needs editor
  return (
    <div
      className="flex items-center gap-2 py-1.5 group"
      style={shared ? { borderLeft: '2px solid var(--accent)', paddingLeft: '0.5rem' } : { paddingLeft: 'calc(0.5rem + 2px)' }}
    >
      <input type="checkbox" checked={packed} onChange={() => onToggle(it)} />
      <span
        className="text-sm flex-1 min-w-0 truncate"
        style={{ color: packed ? 'var(--text-faint)' : 'var(--text)' }}
      >
        {it.name}
      </span>
      {/* Fixed-width counts column so steppers line up across rows */}
      <div className="shrink-0 flex items-center justify-end gap-1" style={{ width: '5rem', color: 'var(--text-faint)' }}>
        {it.quantity > 1 && (
          <>
            <button onClick={() => onStep(it, -1)} className="text-xs hover:opacity-70 px-1" title="Pack one less">−</button>
            <span className="text-xs tabular-nums">{it.packed_count}/{it.quantity}</span>
            <button onClick={() => onStep(it, 1)} className="text-xs hover:opacity-70 px-1" title="Pack one more">+</button>
          </>
        )}
      </div>
      {/* Fixed-width shared column to the right of the counts */}
      <div className="shrink-0 flex justify-start" style={{ width: '4.5rem' }}>
        {shared && (
          <span style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', fontSize: '0.6rem' }}
                className="px-1.5 py-0.5 rounded uppercase tracking-wide font-medium">Shared</span>
        )}
      </div>
      <select
        value={it.bag_id ?? ''} onChange={e => onPatch(it.id, { bag_id: e.target.value ? Number(e.target.value) : null })}
        title="Move to bag"
        style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-faint)', fontSize: '0.7rem' }}
        className="edit-btn rounded px-1 py-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <option value="">No bag</option>
        {bags.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      {editable && (
        <button onClick={() => onEdit(it)} style={{ color: 'var(--text-faint)' }}
                className="edit-btn text-xs shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 transition-opacity" title="Edit">✎</button>
      )}
    </div>
  )
}
