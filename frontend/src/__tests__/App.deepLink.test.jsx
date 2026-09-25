import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle, useEffect } from 'react'

/**
 * A copied /t/:tripId[/day|item|stop/:value] link (urlPath.js) should open
 * straight into that trip/day/item/stop on a fresh boot, bypassing
 * TripList's own "next upcoming trip" auto-open entirely — see App.jsx's
 * deep-link boot effect, openTrip's deepLinkTarget param, and
 * TripTimeline.jsx's initialStopId handling.
 */

const { getTrip, getTrips, getPending } = vi.hoisted(() => ({
  getTrip: vi.fn(),
  getTrips: vi.fn(),
  getPending: vi.fn().mockResolvedValue([]),
}))

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAuthConfig: vi.fn().mockResolvedValue({ enabled: false, client_id: '' }),
    getTrips,
    getPending,
    exportTripPdf: vi.fn(),
    refreshAuthToken: vi.fn().mockResolvedValue({}),
    getTrip,
  }
})

vi.mock('../online.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useOnline: vi.fn(() => true) }
})

const { TripTimelineMock, applyNavSpy } = vi.hoisted(() => ({
  TripTimelineMock: vi.fn(),
  applyNavSpy: vi.fn(),
}))
vi.mock('../components/TripTimeline.jsx', () => ({
  default: forwardRef((props, ref) => {
    useImperativeHandle(ref, () => ({ applyNav: applyNavSpy }))
    return TripTimelineMock(props)
  }),
}))

vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import App from '../App.jsx'

const TRIP = { id: 1, name: 'Solo Trip', start_date: '2026-09-01', end_date: '2026-09-20', role: 'owner' }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  window.history.replaceState(null, '', '/') // each test below sets its own path explicitly via setPath()
  getTrips.mockResolvedValue([TRIP])
  getTrip.mockResolvedValue(TRIP)
  TripTimelineMock.mockImplementation(({ onStops }) => {
    useEffect(() => { onStops?.([]) }, [])
    return <div data-testid="timeline" />
  })
})

afterEach(() => { localStorage.clear() })

function setPath(path) {
  window.history.replaceState(null, '', path)
}

describe('deep link boot', () => {
  it('a bare /t/:id link opens that trip directly, without ever mounting TripList', async () => {
    setPath('/t/1')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Solo Trip')).toBeTruthy())
    expect(getTrip).toHaveBeenCalledWith(1)
    expect(getTrips).not.toHaveBeenCalled()
    const lastCall = TripTimelineMock.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: false }))
  })

  it('a /t/:id/day/:day link opens Today mode and applies that exact day via TripTimeline.applyNav', async () => {
    // Deliberately NOT the initialDay prop (todayInitialDay in App.jsx) —
    // that value doubles as the "All days" button's signal that a Calendar
    // layer sits underneath, which isn't true for a deep link. See
    // App.jsx's pendingDeepLinkNavRef comment.
    setPath('/t/1/day/2026-09-16')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Solo Trip')).toBeTruthy())
    await waitFor(() => expect(applyNavSpy).toHaveBeenCalled())
    expect(applyNavSpy).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-09-16', item: null }))
    const lastCall = TripTimelineMock.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: true, initialDay: null }))
  })

  it('a /t/:id/item/:itemId link opens Today mode and resolves the item via applyNav once TripTimeline mounts', async () => {
    setPath('/t/1/item/7')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Solo Trip')).toBeTruthy())
    await waitFor(() => expect(applyNavSpy).toHaveBeenCalled())
    expect(applyNavSpy).toHaveBeenCalledWith(expect.objectContaining({ item: { id: 7, edit: false } }))
    const lastCall = TripTimelineMock.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: true }))
  })

  it('a /t/:id/stop/:stopId link opens Today mode and passes initialStopId through to TripTimeline', async () => {
    setPath('/t/1/stop/9')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Solo Trip')).toBeTruthy())
    const lastCall = TripTimelineMock.mock.calls.at(-1)
    expect(lastCall[0]).toEqual(expect.objectContaining({ todayMode: true, initialStopId: '9' }))
  })

  it('a bad/deleted trip id falls through to the trip list, same as a stale share link', async () => {
    setPath('/t/999')
    getTrip.mockRejectedValue(new Error('not found'))
    getTrips.mockResolvedValue([TRIP])
    render(<App />)
    // Falls back to the normal boot flow — TripList's own auto-open then runs.
    await waitFor(() => expect(getTrips).toHaveBeenCalled())
  })

  it('a non-deep-link boot (plain "/") behaves exactly as before: TripList auto-opens the next upcoming trip', async () => {
    setPath('/')
    render(<App />)
    await waitFor(() => expect(screen.getByText('Solo Trip')).toBeTruthy())
    expect(getTrips).toHaveBeenCalled()
  })
})
