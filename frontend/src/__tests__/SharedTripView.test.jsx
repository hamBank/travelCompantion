import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  getSharedTimeline: vi.fn(),
  getWeather: vi.fn(() => Promise.resolve({ weather: {} })),
}))
import { getSharedTimeline } from '../api.js'
import SharedTripView from '../components/SharedTripView.jsx'

const timeline = {
  id: 1,
  name: 'Family Trip',
  role: 'viewer',
  stops: [
    {
      id: 10, location: 'Rome', country: '', arrive: null, depart: null,
      timezone: '0', lat: '', lng: '', sort_order: 0, status: 'planned',
      items: [
        { id: 100, stop_id: 10, kind: 'restaurant', name: 'La Carbonara', scheduled_at: null, link: '', cost: '', notes: '', status: 'pending', details: {} },
      ],
    },
  ],
}

beforeEach(() => vi.clearAllMocks())

describe('SharedTripView', () => {
  it('shows a loading state, then the trip name and stop content', async () => {
    getSharedTimeline.mockResolvedValue(timeline)
    render(<SharedTripView token="abc123" />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('Family Trip')).toBeInTheDocument())
    expect(screen.getByText('La Carbonara')).toBeInTheDocument()
    expect(getSharedTimeline).toHaveBeenCalledWith('abc123')
  })

  it('shows an error message when the token is invalid/revoked', async () => {
    getSharedTimeline.mockRejectedValue(new Error('This link is no longer valid.'))
    render(<SharedTripView token="dead" />)
    await waitFor(() => expect(screen.getByText('This link is no longer valid.')).toBeInTheDocument())
  })

  it('never renders edit affordances (read-only viewer role)', async () => {
    getSharedTimeline.mockResolvedValue(timeline)
    render(<SharedTripView token="abc123" />)
    await waitFor(() => expect(screen.getByText('La Carbonara')).toBeInTheDocument())
    // Editor-only controls (add item, edit, delete) must not appear.
    expect(screen.queryByText(/\+ Add item/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })
})
