import { describe, it, expect, afterEach, vi } from 'vitest'
import { isServerDown, resetServerDownForTests } from '../online.js'
import { getHourlyWeather, getTrips } from '../api.js'

// A 502/503/504 from a reverse proxy or restarting backend during a deploy
// should flip the app into offline mode. A 503 the app itself returns
// intentionally for one failed feature (e.g. weather/hourly's transient-
// upstream error) must not — see the regression this covers: a Singapore
// hourly-forecast 503 was tripping the whole app into "server down" even
// though the backend was healthy and every other endpoint worked fine.
// 503 is disambiguated by probing /health (see isRealDeployDown in api.js).
describe('req() deploy-down detection', () => {
  afterEach(() => {
    resetServerDownForTests()
    vi.restoreAllMocks()
  })

  it('does not mark the server down on an app-level 503 when /health is fine', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/health') return Promise.resolve({ ok: true, status: 200, text: async () => '{}' })
      return Promise.resolve({
        status: 503, ok: false,
        text: async () => JSON.stringify({ detail: 'Hourly forecast unavailable' }),
      })
    })
    await expect(getHourlyWeather(1.35, 103.82, '2026-07-22')).rejects.toThrow('Hourly forecast unavailable')
    expect(isServerDown()).toBe(false)
  })

  it('marks the server down on a 503 when /health also fails (real deploy window)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 503, ok: false,
      text: async () => JSON.stringify({ detail: 'Service Unavailable' }),
    })
    global.caches = { match: vi.fn().mockResolvedValue(undefined) }
    await expect(getTrips()).rejects.toThrow('Service Unavailable')
    expect(isServerDown()).toBe(true)
    delete global.caches
  })

  it('marks the server down on a 502/504 unconditionally, without probing /health', async () => {
    global.fetch = vi.fn().mockResolvedValue({ status: 502, ok: false, text: async () => '' })
    await getTrips()
    expect(isServerDown()).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
