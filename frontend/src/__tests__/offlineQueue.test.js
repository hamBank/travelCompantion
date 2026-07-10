import { describe, it, expect, beforeEach } from 'vitest'
import { OfflineQueue, memoryAdapter } from '../offlineQueue.js'

describe('OfflineQueue', () => {
  let queue

  beforeEach(() => {
    queue = new OfflineQueue(memoryAdapter())
  })

  describe('enqueue', () => {
    it('creates a new op for a fresh entity', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      const pending = await queue.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        entity: 'item', entityId: 1,
        changes: { status: 'done' }, base: { status: 'pending' },
      })
    })

    it('coalesces a second edit to the same field: keeps first base, takes last value', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'confirmed' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'confirmed' } })
      const pending = await queue.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].changes).toEqual({ status: 'done' })
      expect(pending[0].base).toEqual({ status: 'pending' })
    })

    it('merges edits to different fields on the same entity into one op', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { notes: 'new note' }, base: { notes: 'old note' } })
      const pending = await queue.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].changes).toEqual({ status: 'done', notes: 'new note' })
      expect(pending[0].base).toEqual({ status: 'pending', notes: 'old note' })
    })

    it('merges details-key edits key-by-key, keeping the first base per key', async () => {
      await queue.enqueue({
        entity: 'item', entityId: 1,
        changes: { details: { notes: 'v1' } }, base: { details: { notes: 'orig' } },
      })
      await queue.enqueue({
        entity: 'item', entityId: 1,
        changes: { details: { notes: 'v2', flight_number: 'BA1' } },
        base: { details: { notes: 'v1', flight_number: '' } },
      })
      const pending = await queue.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0].changes.details).toEqual({ notes: 'v2', flight_number: 'BA1' })
      expect(pending[0].base.details).toEqual({ notes: 'orig', flight_number: '' })
    })

    it('keeps separate entities and separate entity types as distinct ops', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'item', entityId: 2, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'stop', entityId: 1, changes: { status: 'completed' }, base: { status: 'planned' } })
      expect(await queue.count()).toBe(3)
    })
  })

  describe('flush', () => {
    it('replays ops FIFO and removes each on success', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'item', entityId: 2, changes: { status: 'done' }, base: { status: 'pending' } })
      const order = []
      const result = await queue.flush(async (op) => { order.push(op.entityId) })
      expect(order).toEqual([1, 2])
      expect(result).toEqual({ synced: 2, conflicted: 0, authExpired: false })
      expect(await queue.count()).toBe(0)
    })

    it('moves a 409 op into the conflicts store and continues with the rest', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'item', entityId: 2, changes: { status: 'done' }, base: { status: 'pending' } })
      const result = await queue.flush(async (op) => {
        if (op.entityId === 1) {
          const err = new Error('conflict')
          err.status = 409
          err.body = { conflicts: [{ field: 'status', base: 'pending', server: 'cancelled', mine: 'done' }] }
          throw err
        }
      })
      expect(result).toEqual({ synced: 1, conflicted: 1, authExpired: false })
      expect(await queue.count()).toBe(0)
      const conflicts = await queue.conflicts()
      expect(conflicts).toHaveLength(1)
      expect(conflicts[0].entityId).toBe(1)
      expect(conflicts[0].conflictBody.conflicts[0].server).toBe('cancelled')
    })

    it('stops on a network failure, leaving remaining ops queued for next time', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'item', entityId: 2, changes: { status: 'done' }, base: { status: 'pending' } })
      const result = await queue.flush(async () => { throw new Error('network down') })
      expect(result).toEqual({ synced: 0, conflicted: 0, authExpired: false })
      expect(await queue.count()).toBe(2)
    })

    it('reports authExpired on a 401 and stops, leaving ops queued', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.enqueue({ entity: 'item', entityId: 2, changes: { status: 'done' }, base: { status: 'pending' } })
      const result = await queue.flush(async () => {
        const err = new Error('Not authenticated')
        err.status = 401
        throw err
      })
      expect(result).toEqual({ synced: 0, conflicted: 0, authExpired: true })
      expect(await queue.count()).toBe(2)
    })

    it('is idempotent under a duplicate flush (server treats a repeat send as a no-op)', async () => {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      let calls = 0
      const sender = async () => { calls++ }
      await queue.flush(sender)
      await queue.flush(sender) // nothing left to replay
      expect(calls).toBe(1)
    })
  })

  describe('resolveConflict', () => {
    async function seedConflict() {
      await queue.enqueue({ entity: 'item', entityId: 1, changes: { status: 'done' }, base: { status: 'pending' } })
      await queue.flush(async () => {
        const err = new Error('conflict')
        err.status = 409
        err.body = { conflicts: [{ field: 'status', base: 'pending', server: 'cancelled', mine: 'done' }] }
        throw err
      })
    }

    it('"theirs" discards the parked op without sending anything', async () => {
      await seedConflict()
      let called = false
      await queue.resolveConflict((await queue.conflicts())[0].id, 'theirs', async () => { called = true })
      expect(called).toBe(false)
      expect(await queue.conflicts()).toHaveLength(0)
    })

    it('"mine" resends the op\'s changes with no base, then clears it', async () => {
      await seedConflict()
      const id = (await queue.conflicts())[0].id
      let sentWith
      await queue.resolveConflict(id, 'mine', async (op) => { sentWith = op })
      expect(sentWith.base).toBeUndefined()
      expect(sentWith.changes).toEqual({ status: 'done' })
      expect(await queue.conflicts()).toHaveLength(0)
    })
  })
})
