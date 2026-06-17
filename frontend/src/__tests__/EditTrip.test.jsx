import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditTrip from '../components/EditTrip.jsx'
import * as api from '../api.js'

const TRIP = { id: 1, name: 'Euro Trip', start_date: null, end_date: null }
const TIMELINE = { id: 1, name: 'Euro Trip', start_date: null, end_date: null, stops: [] }

beforeEach(() => {
  vi.spyOn(api, 'getTripTimeline').mockResolvedValue(TIMELINE)
  vi.spyOn(api, 'updateTrip').mockResolvedValue({ ...TRIP })
})

describe('EditTrip', () => {
  it('renders trip name input with current value', async () => {
    render(<EditTrip trip={TRIP} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('Euro Trip')).toBeInTheDocument()
    })
  })

  it('renders start date and end date inputs', async () => {
    render(<EditTrip trip={TRIP} />)
    await waitFor(() => {
      expect(screen.getByLabelText(/start date/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/end date/i)).toBeInTheDocument()
    })
  })

  it('shows pre-filled dates when trip has them', async () => {
    const tripWithDates = {
      ...TRIP,
      start_date: '2026-07-01T00:00:00',
      end_date: '2026-07-14T00:00:00',
    }
    vi.spyOn(api, 'getTripTimeline').mockResolvedValue({ ...TIMELINE, ...tripWithDates })
    render(<EditTrip trip={tripWithDates} />)
    await waitFor(() => {
      expect(screen.getByDisplayValue('2026-07-01')).toBeInTheDocument()
      expect(screen.getByDisplayValue('2026-07-14')).toBeInTheDocument()
    })
  })

  it('calls updateTrip with new name on blur', async () => {
    const user = userEvent.setup()
    render(<EditTrip trip={TRIP} />)
    await waitFor(() => screen.getByDisplayValue('Euro Trip'))

    const input = screen.getByDisplayValue('Euro Trip')
    await user.clear(input)
    await user.type(input, 'Asia Tour')
    await user.tab()

    expect(api.updateTrip).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name: 'Asia Tour' })
    )
  })

  it('calls updateTrip with start_date on blur', async () => {
    const user = userEvent.setup()
    render(<EditTrip trip={TRIP} />)
    await waitFor(() => screen.getByLabelText(/start date/i))

    const dateInput = screen.getByLabelText(/start date/i)
    await user.type(dateInput, '2026-08-01')
    await user.tab()

    await waitFor(() => {
      expect(api.updateTrip).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ start_date: '2026-08-01T00:00:00' })
      )
    })
  })

  it('renders Add stop button', async () => {
    render(<EditTrip trip={TRIP} />)
    await waitFor(() => {
      expect(screen.getByText(/add stop/i)).toBeInTheDocument()
    })
  })

  it('shows stop cards when timeline has stops', async () => {
    const timelineWithStop = {
      ...TIMELINE,
      stops: [{
        id: 10, location: 'Paris', country: 'France',
        arrive: null, depart: null, status: 'planned',
        accommodation: '', accommodation_link: '', accommodation_notes: '',
        check_in: '', check_out: '', timezone: '0', lat: '', lng: '',
        sort_order: 0, trip_id: 1, items: [],
      }],
    }
    vi.spyOn(api, 'getTripTimeline').mockResolvedValue(timelineWithStop)
    render(<EditTrip trip={TRIP} />)
    await waitFor(() => {
      expect(screen.getByText('Paris')).toBeInTheDocument()
    })
  })
})
