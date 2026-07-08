// Offline write queue (plan 11): a FIFO queue of pending PATCH ops (status
// cycling, packing toggles, item-edit Saves) made while offline. Flushed on
// reconnect; a 409 (a field changed on the server too, differently) moves
// the op into a separate `conflicts` store instead of being retried.
//
// The queueing/coalescing/flush logic (OfflineQueue) is pure aside from the
// injected storage adapter, so vitest can exercise it against an in-memory
// adapter instead of real IndexedDB — the same separation backend/weather.py
// uses for its injectable `fetch_json`.
import { useState, useEffect, useCallback } from 'react'
import { updateItem, updateStop, updatePackItem } from './api.js'

const DB_NAME = 'tc-offline-queue'
const DB_VERSION = 1
export const OPS_STORE = 'ops'
export const CONFLICTS_STORE = 'conflicts'

// ── IndexedDB adapter (the real one, used by the running app) ──────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(OPS_STORE)) db.createObjectStore(OPS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CONFLICTS_STORE)) db.createObjectStore(CONFLICTS_STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export function idbAdapter() {
  let dbPromise = null
  const getDb = () => (dbPromise ??= openDb())
  return {
    async getAll(storeName) {
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    },
    async put(storeName, value) {
      const db = await getDb()
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(value)
      return txDone(tx)
    },
    async delete(storeName, id) {
      const db = await getDb()
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).delete(id)
      return txDone(tx)
    },
  }
}

// ── In-memory adapter (tests) ───────────────────────────────────────────────

export function memoryAdapter() {
  const stores = { [OPS_STORE]: new Map(), [CONFLICTS_STORE]: new Map() }
  return {
    async getAll(storeName) { return [...stores[storeName].values()] },
    async put(storeName, value) { stores[storeName].set(value.id, value) },
    async delete(storeName, id) { stores[storeName].delete(id) },
  }
}

function uuid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const QUEUE_CHANGED_EVENT = 'tc-offline-queue-changed'

// Lets useOfflineQueue() (and anything else) know the pending/conflicts
// stores changed, without every caller having to know about React state.
function notifyChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT))
}

// ── Queue ────────────────────────────────────────────────────────────────

export class OfflineQueue {
  constructor(adapter) {
    this.adapter = adapter || idbAdapter()
  }

  /** Queue a change against one entity. Coalesces per (entity, entityId):
   * a second offline edit merges into the first op — per field, the
   * *first* op's `base` is kept and the *last* op's value wins ("from what
   * I originally saw, to my final answer"). `details` is merged key-by-key
   * the same way, one level deeper.
   *
   * changes/base shape: { status: "done" } or, for a details edit,
   * { details: { notes: "new" } } / { details: { notes: "old" } }. */
  async enqueue({ entity, entityId, changes, base }) {
    const ops = await this.adapter.getAll(OPS_STORE)
    const existing = ops.find(o => o.entity === entity && o.entityId === entityId)

    if (!existing) {
      const op = { id: uuid(), ts: Date.now(), entity, entityId, changes: { ...changes }, base: { ...base } }
      await this.adapter.put(OPS_STORE, op)
      notifyChanged()
      return op
    }

    const mergedChanges = { ...existing.changes }
    const mergedBase = { ...existing.base }
    for (const [field, value] of Object.entries(changes || {})) {
      if (field === 'details' && value && typeof value === 'object') {
        const baseDetails = (base && base.details) || {}
        mergedChanges.details = { ...(mergedChanges.details || {}), ...value }
        const keptBaseDetails = { ...(mergedBase.details || {}) }
        for (const key of Object.keys(value)) {
          if (!(key in keptBaseDetails)) keptBaseDetails[key] = baseDetails[key]
        }
        mergedBase.details = keptBaseDetails
        continue
      }
      mergedChanges[field] = value
      if (!(field in mergedBase)) mergedBase[field] = base ? base[field] : undefined
    }
    existing.changes = mergedChanges
    existing.base = mergedBase
    existing.ts = Date.now()
    await this.adapter.put(OPS_STORE, existing)
    notifyChanged()
    return existing
  }

  async pending() { return this.adapter.getAll(OPS_STORE) }
  async count() { return (await this.pending()).length }
  async conflicts() { return this.adapter.getAll(CONFLICTS_STORE) }

  /** FIFO replay. `sender(op)` must perform the network PATCH and:
   *  - resolve on success (including a no-op "already applied" 200);
   *  - reject with an Error whose `.status === 409` and `.body` holding
   *    the server's `{conflicts, current}` payload, on a real conflict;
   *  - reject with anything else (network error) to stop the flush —
   *    remaining ops stay queued for the next trigger.
   * Idempotent: replaying an already-synced op is a no-op on the server
   * (value-equality — see backend/compare_and_set.py), so flushing twice
   * (duplicate tabs, flaky reconnects) is harmless. */
  async flush(sender) {
    const ops = (await this.pending()).sort((a, b) => a.ts - b.ts)
    let synced = 0, conflicted = 0
    for (const op of ops) {
      try {
        await sender(op)
        await this.adapter.delete(OPS_STORE, op.id)
        synced++
      } catch (e) {
        if (e && e.status === 409) {
          await this.adapter.put(CONFLICTS_STORE, { ...op, conflictBody: e.body })
          await this.adapter.delete(OPS_STORE, op.id)
          conflicted++
          continue
        }
        break
      }
    }
    if (synced || conflicted) notifyChanged()
    return { synced, conflicted }
  }

  /** Resolve a parked conflict. 'theirs' just discards the op (server value
   * stands). 'mine' re-sends the op's `changes` with no `base` — explicit
   * last-writer-wins, which the server always accepts (can't 409). */
  async resolveConflict(id, resolution, sender) {
    const conflicts = await this.adapter.getAll(CONFLICTS_STORE)
    const conflict = conflicts.find(c => c.id === id)
    if (!conflict) return
    if (resolution === 'mine') {
      await sender({ ...conflict, base: undefined })
    }
    await this.adapter.delete(CONFLICTS_STORE, id)
    notifyChanged()
  }
}

// ── Wiring to the real API (used by app code, not by the unit tests above) ──

const ENDPOINT = { item: updateItem, stop: updateStop, packing: updatePackItem }

/** Default sender: PATCHes the right endpoint for the op's entity, carrying
 * `base` for compare-and-set. Normalizes api.js's plain Error (message-only)
 * into `{status, body}` so OfflineQueue#flush can tell a 409 conflict apart
 * from a network failure. */
export async function sendOp(op) {
  const fn = ENDPOINT[op.entity]
  if (!fn) throw new Error(`Unknown offline-queue entity: ${op.entity}`)
  const body = op.base !== undefined ? { ...op.changes, base: op.base } : { ...op.changes }
  try {
    return await fn(op.entityId, body)
  } catch (e) {
    if (e && e.status === 409) {
      const err = new Error('conflict')
      err.status = 409
      err.body = e.detail
      throw err
    }
    throw e
  }
}

// Single app-wide queue instance backed by real IndexedDB.
export const offlineQueue = new OfflineQueue(idbAdapter())

// ── React hook: pending badge + conflict list ───────────────────────────────

/** Drives the "n changes waiting to sync" badge and the conflict banner/list.
 * Flushes on mount and on the `online` event (the two triggers from plan 11;
 * the third — before the data_version poller's refetch — is step 5, not
 * wired here). */
export function useOfflineQueue(queue = offlineQueue) {
  const [count, setCount] = useState(0)
  const [conflicts, setConflicts] = useState([])

  const refresh = useCallback(async () => {
    setCount(await queue.count())
    setConflicts(await queue.conflicts())
  }, [queue])

  const flush = useCallback(async () => {
    await queue.flush(sendOp)
    await refresh()
  }, [queue, refresh])

  useEffect(() => {
    refresh()
    flush()
    const onOnline = () => flush()
    const onChanged = () => refresh()
    window.addEventListener('online', onOnline)
    window.addEventListener(QUEUE_CHANGED_EVENT, onChanged)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener(QUEUE_CHANGED_EVENT, onChanged)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resolve = useCallback(async (id, resolution) => {
    await queue.resolveConflict(id, resolution, sendOp)
    await refresh()
  }, [queue, refresh])

  return { count, conflicts, flush, resolve }
}
