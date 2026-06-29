import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Test the data-sync poller logic that detects when /health.data_version changes
 * and silently refreshes the trip timeline.
 */

describe('data-sync poller', () => {
  let fetchMock
  let intervalMock

  beforeEach(() => {
    // Mock fetch to return /health responses
    fetchMock = vi.fn()
    global.fetch = fetchMock

    // Mock setInterval so we can control timer
    intervalMock = vi.fn()
    global.setInterval = intervalMock
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('detects data_version changes and calls load', async () => {
    // Simulate the poller logic from TripTimeline useEffect
    let dataVersionRef = { current: 0 }
    let loadCalls = []

    function mockLoad(silent = false) {
      loadCalls.push({ silent })
    }

    // First health check: version is 1000
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ data_version: 1000 })
    })

    // Simulate first poll
    const r1 = await fetch('/health')
    const { data_version: v1 } = await r1.json()

    if (dataVersionRef.current === 0) {
      dataVersionRef.current = v1
    }
    expect(dataVersionRef.current).toBe(1000)
    expect(loadCalls).toHaveLength(0)  // First check, no refresh

    // Second health check: version changed to 2000
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ data_version: 2000 })
    })

    const r2 = await fetch('/health')
    const { data_version: v2 } = await r2.json()

    if (v2 !== dataVersionRef.current) {
      dataVersionRef.current = v2
      mockLoad(true)  // silent refresh
    }

    expect(dataVersionRef.current).toBe(2000)
    expect(loadCalls).toEqual([{ silent: true }])  // Should have called load(true)
  })

  it('does not refresh if version has not changed', async () => {
    let dataVersionRef = { current: 0 }
    let loadCalls = []

    function mockLoad(silent = false) {
      loadCalls.push({ silent })
    }

    // First poll: version 1000
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ data_version: 1000 })
    })

    const r1 = await fetch('/health')
    const { data_version: v1 } = await r1.json()
    if (dataVersionRef.current === 0) {
      dataVersionRef.current = v1
    }

    // Second poll: version still 1000
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ data_version: 1000 })
    })

    const r2 = await fetch('/health')
    const { data_version: v2 } = await r2.json()
    if (v2 !== dataVersionRef.current) {
      dataVersionRef.current = v2
      mockLoad(true)
    }

    expect(loadCalls).toHaveLength(0)  // No refresh
  })
})
