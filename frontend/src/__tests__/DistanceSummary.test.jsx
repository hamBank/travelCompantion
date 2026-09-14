import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import DistanceSummary from '../components/DistanceSummary.jsx'
import * as api from '../api.js'

vi.mock('../api.js')

const trip = { id: 1, name: 'Family Trip' }

const travelTotals = {
  trips: 4,
  days: 37,
  countries: ['FR', 'JP'],
  distance: { by_mode: { air: 18234.0, rail: 812.5 }, total_km: 19046.5 },
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getTripDistance.mockResolvedValue({ by_mode: {}, total_km: 0 })
  api.getMyTravelTotals.mockResolvedValue(travelTotals)
  api.getTravelers.mockResolvedValue([])
  api.getCurrentUser.mockResolvedValue({ email: 'dev@local' })
})

describe('DistanceSummary — My totals', () => {
  it('renders the trips/days/countries line from getMyTravelTotals', async () => {
    render(<DistanceSummary trip={trip} onClose={() => {}} />)
    expect(await screen.findByText(/across 4 trips you're traveling on/)).toBeInTheDocument()
    expect(screen.getByText(/37 days/)).toBeInTheDocument()
    expect(screen.getByText(/2 countries/)).toBeInTheDocument()
  })

  it('singularizes trip/day/country counts of 1', async () => {
    api.getMyTravelTotals.mockResolvedValue({
      trips: 1, days: 1, countries: ['FR'],
      distance: { by_mode: {}, total_km: 0 },
    })
    render(<DistanceSummary trip={trip} onClose={() => {}} />)
    expect(await screen.findByText(/across 1 trip you're traveling on/)).toBeInTheDocument()
    expect(screen.getByText(/1 day\b/)).toBeInTheDocument()
    expect(screen.getByText(/1 country\b/)).toBeInTheDocument()
  })

  it('shows the not-a-traveler hint when the current user is missing from the trip\'s travelers list', async () => {
    api.getTravelers.mockResolvedValue([{ id: 1, user_email: 'someone-else@example.com' }])
    api.getCurrentUser.mockResolvedValue({ email: 'dev@local' })
    render(<DistanceSummary trip={trip} onClose={() => {}} />)
    expect(await screen.findByText(/You're not listed as a traveler on this trip/)).toBeInTheDocument()
  })

  it('hides the not-a-traveler hint when the current user is in the trip\'s travelers list', async () => {
    api.getTravelers.mockResolvedValue([{ id: 1, user_email: 'dev@local' }])
    api.getCurrentUser.mockResolvedValue({ email: 'dev@local' })
    render(<DistanceSummary trip={trip} onClose={() => {}} />)
    await waitFor(() => expect(api.getTravelers).toHaveBeenCalledWith(1))
    expect(screen.queryByText(/You're not listed as a traveler on this trip/)).not.toBeInTheDocument()
  })
})
