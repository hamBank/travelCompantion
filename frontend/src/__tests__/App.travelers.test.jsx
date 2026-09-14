import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * Travelers menu wiring in App.jsx (plan-17c): the hamburger's Travelers item
 * (next to Share, any role) opens TravelersModal with the selected trip and
 * signed-in user's email. TravelersModal's own behavior (list/add/edit/
 * profile) is covered by TravelersModal.test.jsx — this file only checks the
 * App-level mount/props wiring, mirroring App.calendar.test.jsx's pattern.
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
    getTripTimeline: vi.fn().mockResolvedValue({ id: 1, start_date: '2026-09-14', end_date: '2026-09-20', stops: [] }),
  }
})

vi.mock('../components/TripTimeline.jsx', () => ({
  default: vi.fn(() => <div data-testid="timeline" />),
}))

vi.mock('../components/TravelersModal.jsx', () => ({
  default: vi.fn(({ trip, userEmail, onClose }) => (
    <div data-testid="travelers-modal" data-trip-id={trip.id} data-user-email={userEmail}>
      <button onClick={onClose}>close-travelers</button>
    </div>
  )),
}))

vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import { getTrips } from '../api.js'
import TripTimeline from '../components/TripTimeline.jsx'
import TravelersModal from '../components/TravelersModal.jsx'
import { clearNav } from '../navState.js'
import App from '../App.jsx'

const TRIP = { id: 1, name: 'Solo Trip', start_date: '2026-09-14', end_date: '2026-09-20', role: 'viewer' }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNav()
  getTrips.mockResolvedValue([TRIP])
})

afterEach(() => { clearNav() })

describe('Travelers menu item', () => {
  it('opens TravelersModal with the trip and user email, for a non-owner role', async () => {
    render(<App />)
    fireEvent.click(await screen.findByText('Solo Trip'))
    await waitFor(() => expect(TripTimeline).toHaveBeenCalled())

    fireEvent.click(screen.getByLabelText('Menu'))
    // Share is owner-only and hidden for this viewer trip; Travelers is not.
    expect(screen.queryByText('Share')).toBeNull()
    fireEvent.click(screen.getByText('Travelers'))

    await waitFor(() => expect(TravelersModal).toHaveBeenCalled())
    const modal = screen.getByTestId('travelers-modal')
    expect(modal.dataset.tripId).toBe('1')
    expect(modal.dataset.userEmail).toBe('dev@local')

    fireEvent.click(screen.getByText('close-travelers'))
    expect(screen.queryByTestId('travelers-modal')).toBeNull()
  })
})
