import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  createTrip: vi.fn(),
}))

import { createTrip } from '../api.js'
import CreateTripModal from '../components/CreateTripModal.jsx'

beforeEach(() => vi.clearAllMocks())

describe('CreateTripModal', () => {
  it('requires a trip name before creating', async () => {
    const onCreated = vi.fn()
    render(<CreateTripModal onClose={() => {}} onCreated={onCreated} />)

    fireEvent.click(screen.getByText('Create trip'))

    expect(await screen.findByText('Trip name is required')).toBeTruthy()
    expect(createTrip).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('creates a trip with name, dates, and budget, then calls onCreated', async () => {
    const newTrip = { id: 5, name: 'Japan 2027' }
    createTrip.mockResolvedValue(newTrip)
    const onCreated = vi.fn()
    render(<CreateTripModal onClose={() => {}} onCreated={onCreated} />)

    fireEvent.change(screen.getByLabelText('Trip name'), { target: { value: 'Japan 2027' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-04-01' } })
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-04-15' } })
    fireEvent.change(screen.getByLabelText(/Budget/), { target: { value: '3000 USD' } })
    fireEvent.click(screen.getByText('Create trip'))

    await waitFor(() => expect(createTrip).toHaveBeenCalledWith({
      name: 'Japan 2027',
      start_date: '2027-04-01T00:00:00',
      end_date: '2027-04-15T00:00:00',
      budget: '3000 USD',
    }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(newTrip))
  })

  it('creates a trip with only a name (dates/budget optional)', async () => {
    const newTrip = { id: 6, name: 'Weekend trip' }
    createTrip.mockResolvedValue(newTrip)
    render(<CreateTripModal onClose={() => {}} onCreated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Trip name'), { target: { value: 'Weekend trip' } })
    fireEvent.click(screen.getByText('Create trip'))

    await waitFor(() => expect(createTrip).toHaveBeenCalledWith({
      name: 'Weekend trip', start_date: null, end_date: null, budget: null,
    }))
  })

  it('rejects an end date before the start date without calling the API', async () => {
    render(<CreateTripModal onClose={() => {}} onCreated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Trip name'), { target: { value: 'Bad dates' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-04-15' } })
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-04-01' } })
    fireEvent.click(screen.getByText('Create trip'))

    expect(await screen.findByText(/cannot be before/)).toBeTruthy()
    expect(createTrip).not.toHaveBeenCalled()
  })

  it('shows an error message if creation fails', async () => {
    createTrip.mockRejectedValue(new Error('Server error'))
    render(<CreateTripModal onClose={() => {}} onCreated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Trip name'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Create trip'))

    expect(await screen.findByText('Server error')).toBeTruthy()
  })

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(<CreateTripModal onClose={onClose} onCreated={vi.fn()} />)
    fireEvent.click(container.firstChild)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose via the Cancel button', () => {
    const onClose = vi.fn()
    render(<CreateTripModal onClose={onClose} onCreated={vi.fn()} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })
})
