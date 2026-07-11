import { describe, it, expect, beforeEach } from 'vitest'
import { createVaultOfflineStore, memoryAdapter } from '../vaultOfflineStore.js'

describe('vaultOfflineStore', () => {
  let store

  beforeEach(() => {
    store = createVaultOfflineStore(memoryAdapter())
  })

  it('has() is false for a file never put', async () => {
    expect(await store.has(1)).toBe(false)
  })

  it('put/get round-trips the blob and content type', async () => {
    const blob = new Blob(['hello'], { type: 'image/jpeg' })
    await store.put(1, blob, 'image/jpeg')
    expect(await store.has(1)).toBe(true)
    const entry = await store.get(1)
    expect(entry.contentType).toBe('image/jpeg')
    expect(entry.blob.size).toBe(blob.size)
  })

  it('delete removes the entry', async () => {
    const blob = new Blob(['hello'])
    await store.put(1, blob, 'image/jpeg')
    await store.delete(1)
    expect(await store.has(1)).toBe(false)
    expect(await store.get(1)).toBeUndefined()
  })

  it('keeps separate files independent', async () => {
    await store.put(1, new Blob(['a']), 'image/jpeg')
    await store.put(2, new Blob(['b']), 'application/pdf')
    await store.delete(1)
    expect(await store.has(1)).toBe(false)
    expect(await store.has(2)).toBe(true)
  })
})
