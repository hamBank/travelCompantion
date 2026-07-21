import { describe, it, expect, vi, afterEach } from 'vitest'
import { getTrips, updateItem } from '../api.js'
import { isServerDown, resetServerDownForTests } from '../online.js'

/**
 * Mid-deploy the backend returns 502/503/504 for a short window. Browsing
 * (GETs) must keep working from the service worker's cached copies with no
 * visible error, the app must flip into offline mode, and only actual
 * writes may surface a failure.
 */

function mock503() {
  return {
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    text: async () => JSON.stringify({ detail: 'Service Unavailable' }),
  }
}

afterEach(() => {
  resetServerDownForTests()
  vi.restoreAllMocks()
  delete global.caches
})

describe('deploy-window (5xx) handling in api.req', () => {
  it('serves a GET from the SW cache and marks the server down, with no error thrown', async () => {
    global.fetch = vi.fn().mockResolvedValue(mock503())
    const cachedTrips = [{ id: 1, name: 'Europe 2026' }]
    global.caches = {
      match: vi.fn().mockResolvedValue({ text: async () => JSON.stringify(cachedTrips) }),
    }
    const result = await getTrips()
    expect(result).toEqual(cachedTrips)
    expect(isServerDown()).toBe(true)
    expect(global.caches.match).toHaveBeenCalledWith('/trips/')
  })

  it('still throws on a GET when nothing is cached (but the app has flipped offline)', async () => {
    global.fetch = vi.fn().mockResolvedValue(mock503())
    global.caches = { match: vi.fn().mockResolvedValue(undefined) }
    await expect(getTrips()).rejects.toThrow('Service Unavailable')
    expect(isServerDown()).toBe(true)
  })

  it('lets a write surface the failure (no cache fallback for non-GETs)', async () => {
    global.fetch = vi.fn().mockResolvedValue(mock503())
    global.caches = { match: vi.fn() }
    await expect(updateItem(42, { name: 'x' })).rejects.toThrow('Service Unavailable')
    expect(isServerDown()).toBe(true)
    expect(global.caches.match).not.toHaveBeenCalled()
  })

  it('does not mark the server down on ordinary errors (e.g. a 404)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found',
      text: async () => JSON.stringify({ detail: 'Item not found' }),
    })
    await expect(getTrips()).rejects.toThrow('Item not found')
    expect(isServerDown()).toBe(false)
  })
})
