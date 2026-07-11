// Document vault offline cache (plan-12c): a read-side cache of already-
// fetched, already-decrypted document file bytes, keyed by file id. This is
// a DIFFERENT job from offlineQueue.js (a write queue for outgoing PATCH
// ops) — kept as a separate module even though both live under the
// "offline" umbrella. Same injectable-adapter testability pattern as
// offlineQueue.js so vitest can swap in an in-memory Map instead of real
// IndexedDB.
//
// v1 stores bytes unencrypted client-side (server-side encryption only —
// see docs/plans/plan-12-document-vault.md's Constraints); caching is
// strictly opt-in per document via the "Available offline" toggle, never
// automatic just from viewing a document online.

const DB_NAME = 'tc-vault-offline'
const DB_VERSION = 1
const STORE = 'files'

// ── IndexedDB adapter (the real one, used by the running app) ──────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'fileId' })
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
    async get(fileId) {
      const db = await getDb()
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(fileId)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    },
    async put(entry) {
      const db = await getDb()
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry)
      return txDone(tx)
    },
    async delete(fileId) {
      const db = await getDb()
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(fileId)
      return txDone(tx)
    },
  }
}

// ── In-memory adapter (tests) ───────────────────────────────────────────────

export function memoryAdapter() {
  const map = new Map()
  return {
    async get(fileId) { return map.get(fileId) },
    async put(entry) { map.set(entry.fileId, entry) },
    async delete(fileId) { map.delete(fileId) },
  }
}

export function createVaultOfflineStore(adapter = idbAdapter()) {
  return {
    async put(fileId, blob, contentType) {
      await adapter.put({ fileId, blob, contentType })
    },
    async get(fileId) {
      const entry = await adapter.get(fileId)
      return entry ? { blob: entry.blob, contentType: entry.contentType } : undefined
    },
    async has(fileId) {
      return (await adapter.get(fileId)) !== undefined
    },
    async delete(fileId) {
      await adapter.delete(fileId)
    },
  }
}

// Shared instance for the running app (frontend/src/api.js-style singleton) —
// components import this rather than each constructing their own store over
// a fresh IndexedDB connection.
export const vaultOfflineStore = createVaultOfflineStore()
