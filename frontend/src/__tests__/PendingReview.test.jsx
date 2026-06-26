import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  getPending: vi.fn(),
  updatePending: vi.fn(),
  applyPending: vi.fn(),
  discardPending: vi.fn(),
  getTrips: vi.fn(),
  getTripTimeline: vi.fn(),
}))
import { getPending, updatePending, applyPending, discardPending, getTrips } from '../api.js'
import PendingReview from '../components/PendingReview.jsx'

const stops = [{ id: 1, location: 'Rome', arrive: '2026-08-01' }]
const row = {
  id: 5, kind: 'activity', op: 'create', trip_id: 1, suggested_stop_id: 1,
  confidence: 'high', match_reason: 'matched by date',
  payload: { name: 'Colosseum', scheduled_at: null, cost: '€20', link: '', notes: '', details: { location: 'Rome' } },
}

beforeEach(() => vi.clearAllMocks())

describe('PendingReview', () => {
  it('lists pending rows from the API', async () => {
    getPending.mockResolvedValue([row])
    render(<PendingReview tripId={1} stops={stops} onClose={() => {}} />)
    expect(await screen.findByDisplayValue('Colosseum')).toBeInTheDocument()
    expect(screen.getByText(/high confidence/)).toBeInTheDocument()
  })

  it('applies a row: patches edits then applies, and notifies parent', async () => {
    getPending.mockResolvedValueOnce([row]).mockResolvedValueOnce([])
    updatePending.mockResolvedValue({})
    applyPending.mockResolvedValue({})
    const onChanged = vi.fn()
    render(<PendingReview tripId={1} stops={stops} onClose={() => {}} onChanged={onChanged} />)
    await screen.findByDisplayValue('Colosseum')
    fireEvent.click(screen.getByText('Add to trip'))
    await waitFor(() => expect(applyPending).toHaveBeenCalledWith(5))
    expect(updatePending).toHaveBeenCalledWith(5, expect.objectContaining({ suggested_stop_id: 1, trip_id: 1 }))
    expect(onChanged).toHaveBeenCalled()
  })

  it('discards a row', async () => {
    getPending.mockResolvedValueOnce([row]).mockResolvedValueOnce([])
    discardPending.mockResolvedValue(null)
    render(<PendingReview tripId={1} stops={stops} onClose={() => {}} />)
    await screen.findByDisplayValue('Colosseum')
    fireEvent.click(screen.getByText('Discard'))
    await waitFor(() => expect(discardPending).toHaveBeenCalledWith(5))
  })

  it('blocks apply when no stop is selected', async () => {
    getPending.mockResolvedValue([{ ...row, suggested_stop_id: null }])
    render(<PendingReview tripId={1} stops={stops} onClose={() => {}} />)
    await screen.findByDisplayValue('Colosseum')
    fireEvent.click(screen.getByText('Add to trip'))
    await waitFor(() => expect(screen.getByText(/Pick a stop/)).toBeInTheDocument())
    expect(applyPending).not.toHaveBeenCalled()
  })

  it('shows the empty state when nothing is pending', async () => {
    getPending.mockResolvedValue([])
    render(<PendingReview tripId={1} stops={stops} onClose={() => {}} />)
    expect(await screen.findByText(/Nothing to review/)).toBeInTheDocument()
  })

  it('global mode (no tripId): blocks apply until a trip is picked', async () => {
    getPending.mockResolvedValue([{ ...row, trip_id: null, suggested_stop_id: null }])
    getTrips.mockResolvedValue([{ id: 7, name: 'Trip A' }])
    render(<PendingReview onClose={() => {}} />)  // no tripId → global mode
    await screen.findByDisplayValue('Colosseum')
    expect(screen.getByText('— Select a trip —')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Add to trip'))
    await waitFor(() => expect(screen.getByText(/Pick a trip/)).toBeInTheDocument())
    expect(applyPending).not.toHaveBeenCalled()
  })
})
