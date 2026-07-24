import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  getTrips: vi.fn(),
  importFromSheets: vi.fn(),
  deleteTrip: vi.fn(),
}))

import { getTrips } from '../api.js'
import TripList from '../components/TripList.jsx'

beforeEach(() => vi.clearAllMocks())

const TRIPS = [
  { id: 1, name: 'Old Trip', start_date: '2020-01-01', end_date: '2020-01-10' },
  { id: 2, name: 'Upcoming Trip', start_date: '2099-01-01', end_date: '2099-01-10' },
]

describe('TripList — auto-open', () => {
  it('opens the next-upcoming trip by default (no restore point)', async () => {
    getTrips.mockResolvedValue(TRIPS)
    const onOpen = vi.fn()
    render(<TripList onOpen={onOpen} skipAutoOpen={false} />)
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(TRIPS[1], undefined))
  })

  it('restores the saved trip (and its today mode) over the upcoming-trip default', async () => {
    getTrips.mockResolvedValue(TRIPS)
    const onOpen = vi.fn()
    render(<TripList onOpen={onOpen} skipAutoOpen={false} restoreTripId={1} restoreToday={true} />)
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(TRIPS[0], true))
  })

  it('falls back to the upcoming-trip default when the saved trip no longer exists', async () => {
    getTrips.mockResolvedValue(TRIPS)
    const onOpen = vi.fn()
    render(<TripList onOpen={onOpen} skipAutoOpen={false} restoreTripId={999} restoreToday={true} />)
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(TRIPS[1], undefined))
  })

  it('does not auto-open anything when skipAutoOpen is set', async () => {
    getTrips.mockResolvedValue(TRIPS)
    const onOpen = vi.fn()
    render(<TripList onOpen={onOpen} skipAutoOpen={true} restoreTripId={1} restoreToday={true} />)
    await screen.findByText('Old Trip')
    expect(onOpen).not.toHaveBeenCalled()
  })
})
