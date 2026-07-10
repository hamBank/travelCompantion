import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { OfflineQueue, memoryAdapter, useOfflineQueue } from '../offlineQueue.js'
import * as api from '../api.js'

vi.mock('../api.js')

describe('useOfflineQueue', () => {
  let queue

  beforeEach(() => {
    vi.clearAllMocks()
    queue = new OfflineQueue(memoryAdapter())
  })

  it('flushes queued ops on mount via sendOp, updating the count', async () => {
    api.updateItem.mockResolvedValue({ id: 1, status: 'done' })
    await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })

    const { result } = renderHook(() => useOfflineQueue(queue))
    await waitFor(() => expect(result.current.count).toBe(0))
    expect(api.updateItem).toHaveBeenCalledWith(1, { status: 'done', base: { status: 'pending' } })
  })

  it('parks a 409 as a conflict and exposes it', async () => {
    const err = new Error('Conflict')
    err.status = 409
    err.detail = { conflicts: [{ field: 'status', base: 'pending', server: 'cancelled', mine: 'done' }] }
    api.updateItem.mockRejectedValue(err)
    await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })

    const { result } = renderHook(() => useOfflineQueue(queue))
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1))
    expect(result.current.count).toBe(0)
    expect(result.current.conflicts[0].conflictBody.conflicts[0].field).toBe('status')
  })

  it('resolve("mine") resends without base and clears the conflict', async () => {
    const err = new Error('Conflict')
    err.status = 409
    err.detail = { conflicts: [] }
    api.updateItem.mockRejectedValueOnce(err).mockResolvedValueOnce({ id: 1, status: 'done' })
    await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })

    const { result } = renderHook(() => useOfflineQueue(queue))
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1))

    await act(async () => {
      await result.current.resolve(result.current.conflicts[0].id, 'mine')
    })
    expect(api.updateItem).toHaveBeenLastCalledWith(1, { status: 'done' })
    expect(result.current.conflicts).toHaveLength(0)
  })

  it('exposes authExpired on a 401 instead of silently stalling', async () => {
    const err = new Error('Not authenticated')
    err.status = 401
    api.updateItem.mockRejectedValue(err)
    await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })

    const { result } = renderHook(() => useOfflineQueue(queue))
    await waitFor(() => expect(result.current.authExpired).toBe(true))
    expect(result.current.count).toBe(1)  // the op stays queued, not dropped
  })

  it('clears authExpired once a later flush succeeds (e.g. after signing back in)', async () => {
    const err = new Error('Not authenticated')
    err.status = 401
    api.updateItem.mockRejectedValueOnce(err)
    await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })

    const { result } = renderHook(() => useOfflineQueue(queue))
    await waitFor(() => expect(result.current.authExpired).toBe(true))

    api.updateItem.mockResolvedValueOnce({ id: 1, status: 'done' })
    await act(async () => { await result.current.flush() })
    expect(result.current.authExpired).toBe(false)
    expect(result.current.count).toBe(0)
  })

  it('flushes again when the browser fires an online event', async () => {
    api.updateItem.mockResolvedValue({ id: 1, status: 'done' })
    const { result } = renderHook(() => useOfflineQueue(queue))
    await waitFor(() => expect(result.current.count).toBe(0))

    await queue.enqueue({ entity: 'item', entityId: 2, changes: { status: 'done' }, base: { status: 'pending' } })
    expect(await queue.count()).toBe(1)

    act(() => { window.dispatchEvent(new Event('online')) })
    await waitFor(() => expect(result.current.count).toBe(0))
    expect(api.updateItem).toHaveBeenCalledWith(2, { status: 'done', base: { status: 'pending' } })
  })
})
