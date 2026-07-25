import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

/**
 * "Open trips in Today view by default" (settings.js) is a persistent user
 * preference. navState.js's restoreToday — saved on every trip open so a
 * forced reload / iOS process eviction resumes exactly where you left off —
 * used to win over it unconditionally (openTrip's `todayOverride ??
 * getDefaultToToday()`), so once a user had ever closed the app out of
 * Today view, restoreToday=false silently pinned every future open out of
 * Today view too, no matter the setting. Reported directly: "App does not
 * seem to honour the open in day view setting" / "Opening the app mid trip
 * is not opening at the current (users) day".
 */

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAuthConfig: vi.fn().mockResolvedValue({ enabled: false, client_id: '' }),
    getTrips: vi.fn(),
    getPending: vi.fn().mockResolvedValue([]),
    exportTripPdf: vi.fn(),
    refreshAuthToken: vi.fn().mockResolvedValue({}),
  }
})

vi.mock('../components/TripTimeline.jsx', () => ({
  default: vi.fn(({ todayMode }) => <div data-testid="timeline" data-today={String(todayMode)} />),
}))

// Unrelated to what's under test — OfflineQueueBanner (rendered by AppShell
// unconditionally) reads IndexedDB on mount via offlineQueue.js, which jsdom
// doesn't provide.
vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import { getTrips } from '../api.js'
import TripTimeline from '../components/TripTimeline.jsx'
import { setDefaultToToday } from '../settings.js'
import { saveNav, clearNav } from '../navState.js'
import App from '../App.jsx'

const TRIP = { id: 1, name: 'Solo Trip', start_date: '2020-01-01', end_date: '2099-01-10' }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNav()
  getTrips.mockResolvedValue([TRIP])
})

afterEach(() => {
  clearNav()
  setDefaultToToday(false)
})

describe('default-to-today setting vs. restored nav state', () => {
  it('opens in Today view on a fresh auto-open when the setting is on (no saved nav)', async () => {
    setDefaultToToday(true)
    render(<App />)
    await waitFor(() => expect(TripTimeline).toHaveBeenCalled())
    const lastCall = TripTimeline.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: true }))
  })

  it('does not default to Today when the setting is off (no saved nav)', async () => {
    setDefaultToToday(false)
    render(<App />)
    await waitFor(() => expect(TripTimeline).toHaveBeenCalled())
    const lastCall = TripTimeline.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: false }))
  })

  it('honours the setting even when a saved nav point says today=false', async () => {
    setDefaultToToday(true)
    saveNav({ tripId: TRIP.id, today: false })
    render(<App />)
    await waitFor(() => expect(TripTimeline).toHaveBeenCalled())
    const lastCall = TripTimeline.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: true }))
  })

  it('still restores a saved today=true when the setting itself is off', async () => {
    setDefaultToToday(false)
    saveNav({ tripId: TRIP.id, today: true })
    render(<App />)
    await waitFor(() => expect(TripTimeline).toHaveBeenCalled())
    const lastCall = TripTimeline.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: true }))
  })
})
