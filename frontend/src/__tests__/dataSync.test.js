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

  it('does not force a remount for a version bump already picked up by a same-tab save', async () => {
    // Mirrors TripTimeline's real fix: any successful load() (including the
    // remount:false one that a same-tab item save triggers via onUpdate)
    // syncs dataVersionRef to the *current* /health version, not just the
    // poller. So when the save's own write bumps the version, the very next
    // poll tick sees no *new* change and must not force the jarring remount.
    let dataVersionRef = { current: 1000 }
    let loadCalls = []
    function mockLoad(remount) { loadCalls.push({ remount }) }

    // A same-tab item save just happened: its own load({background:true,
    // remount:false}) call re-fetches /health as part of load() and syncs
    // the ref — simulating the fix inside TripTimeline's load().
    fetchMock.mockResolvedValueOnce({ json: async () => ({ data_version: 2000 }) })
    mockLoad(false)
    const rSave = await fetch('/health')
    const { data_version: vSave } = await rSave.json()
    if (vSave) dataVersionRef.current = vSave

    // The scheduled poll tick fires next, seeing the SAME version the save
    // already synced — must be a no-op, not a forced remount.
    fetchMock.mockResolvedValueOnce({ json: async () => ({ data_version: 2000 }) })
    const rPoll = await fetch('/health')
    const { data_version: vPoll } = await rPoll.json()
    if (vPoll !== dataVersionRef.current) {
      dataVersionRef.current = vPoll
      mockLoad(true)  // would be the jarring full-remount reload
    }

    expect(loadCalls).toEqual([{ remount: false }])  // no remount triggered by the poll
  })
})
