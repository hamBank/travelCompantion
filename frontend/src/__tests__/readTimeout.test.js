import { describe, it, expect, vi, afterEach } from 'vitest'
import { getTrips, updateItem } from '../api.js'

/**
 * A GET whose response the service worker can't answer from cache (nothing
 * cached yet for this URL — e.g. the very first network-controlled load of
 * a session) falls through to a real network fetch that, while genuinely
 * offline, can hang far longer than a clean "no network" rejection —
 * reported directly: "loading offline takes quite a while... zero data
 * seems to appear up to 30s of waiting". req() now races GETs against a
 * bounded timeout and falls back to reading Cache Storage directly, same
 * as the deploy-down path, instead of leaving the UI stuck.
 */

function hangingFetch() {
  return new Promise(() => {}) // never resolves/rejects — simulates a stuck request
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete global.caches
})

describe('req() read timeout', () => {
  it('falls back to the cache when the network hangs past the read timeout', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn(hangingFetch)
    const cachedTrips = [{ id: 1, name: 'Europe 2026' }]
    global.caches = { match: vi.fn().mockResolvedValue({ text: async () => JSON.stringify(cachedTrips) }) }

    const promise = getTrips()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(promise).resolves.toEqual(cachedTrips)
    expect(global.caches.match).toHaveBeenCalledWith('/trips/')
  })

  it('rejects with a clear timeout error when the network hangs and nothing is cached', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn(hangingFetch)
    global.caches = { match: vi.fn().mockResolvedValue(undefined) }

    const promise = getTrips()
    const assertion = expect(promise).rejects.toThrow('Request timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('does not apply the read timeout to writes', async () => {
    // A write should surface whatever the network eventually does, not get
    // silently timed out after 5s and potentially double-submitted.
    vi.useFakeTimers()
    global.fetch = vi.fn(hangingFetch)
    let settled = false
    updateItem(1, { name: 'x' }).catch(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(settled).toBe(false)
  })

  it('resolves normally well within the timeout when the network is healthy', async () => {
    const trips = [{ id: 1, name: 'Europe 2026' }]
    global.fetch = vi.fn().mockResolvedValue({ status: 200, ok: true, text: async () => JSON.stringify(trips) })
    await expect(getTrips()).resolves.toEqual(trips)
  })
})
