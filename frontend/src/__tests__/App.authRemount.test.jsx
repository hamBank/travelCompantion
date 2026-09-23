import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { forwardRef } from 'react'

/**
 * Reported: "hitting the (app not browser) back button after an initial
 * load of the app -> which defaults to the latest trip -> results in going
 * 'back' in the browser and exiting the app."
 *
 * Every other history test in this suite mocks getAuthConfig to always
 * resolve { enabled: false } (see App.history.test.jsx), which keeps
 * AuthenticatedApp's render output as the bare <AppShell/> for the whole
 * test. A returning user with a stored token and auth actually enabled
 * hits a different path: AuthenticatedApp renders bare <AppShell/> on the
 * very first render (googleClientId starts '' from useState), then once
 * getAuthConfig() resolves with a real client_id, its return value changes
 * to <GoogleOAuthProvider><AppShell/></GoogleOAuthProvider> — a different
 * element type at the same tree position, which unmounts the original
 * AppShell (discarding its state and losing the trip history push it may
 * already have made) and mounts a brand new one. This checks whether that
 * actually happens.
 */

vi.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }) => children,
}))

const { getTrips, getAuthConfig } = vi.hoisted(() => ({
  getTrips: vi.fn(),
  getAuthConfig: vi.fn(),
}))

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAuthConfig,
    getTrips,
    getPending: vi.fn().mockResolvedValue([]),
    exportTripPdf: vi.fn(),
    refreshAuthToken: vi.fn().mockResolvedValue({}),
  }
})

vi.mock('../historyNav.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    pushNav: vi.fn(actual.pushNav),
    replaceNav: vi.fn(actual.replaceNav),
  }
})

const { TripTimelineMock } = vi.hoisted(() => ({
  TripTimelineMock: vi.fn(() => <div data-testid="timeline" />),
}))
vi.mock('../components/TripTimeline.jsx', () => ({
  default: forwardRef((props, ref) => TripTimelineMock(props, ref)),
}))

vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import { pushNav, replaceNav } from '../historyNav.js'
import App from '../App.jsx'

const TRIP = { id: 1, name: 'Solo Trip', start_date: '2020-01-01', end_date: '2099-01-10', role: 'owner' }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('tc-token', 'fake-jwt') // returning, already-signed-in user
  window.history.replaceState(null, '')
  getTrips.mockResolvedValue([TRIP])
})

afterEach(() => {
  localStorage.clear()
})

describe('AppShell remount when auth config resolves after boot', () => {
  it('does NOT remount AppShell (and does not re-push the auto-opened trip) once getAuthConfig resolves with auth enabled', async () => {
    // getAuthConfig resolves on a later tick, as a real network request
    // would, with auth actually enabled and a real client id — the
    // returning-user-with-a-token case the always-disabled mock in
    // App.history.test.jsx never exercises.
    let resolveAuthConfig
    getAuthConfig.mockReturnValue(new Promise(resolve => { resolveAuthConfig = resolve }))

    render(<App />)
    await waitFor(() => expect(getTrips).toHaveBeenCalled())
    await waitFor(() => expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1 })))

    const replaceCallsBefore = replaceNav.mock.calls.length
    const pushCallsBefore = pushNav.mock.calls.length
    const getTripsCallsBefore = getTrips.mock.calls.length

    resolveAuthConfig({ enabled: true, client_id: 'test-client-id' })
    await waitFor(() => expect(TripTimelineMock).toHaveBeenCalled())
    // give any remount's own effects a chance to run
    await new Promise(r => setTimeout(r, 20))

    expect(getTrips.mock.calls.length).toBe(getTripsCallsBefore)
    expect(pushNav.mock.calls.length).toBe(pushCallsBefore)
    expect(replaceNav.mock.calls.length).toBe(replaceCallsBefore)
  })
})
