import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  createItem: vi.fn(),
  updateItem: vi.fn(),
  enrichPlace: vi.fn(),
  washLookup: vi.fn(),
  uploadGpx: vi.fn(),
  lookupAirline: vi.fn(),
  fetchRouteElevation: vi.fn(),
  fetchGeocode: vi.fn(),
  deleteItem: vi.fn(),
  routeDistance: vi.fn(),
  routeToGpx: vi.fn(),
  getItemStops: vi.fn(),
  moveItem: vi.fn(),
  generateRiverPath: vi.fn(),
  getBookingPrimary: vi.fn(),
}))
import { enrichPlace, getItemStops, getBookingPrimary } from '../api.js'
import ItemEditModal from '../components/ItemEditModal.jsx'

beforeEach(() => vi.clearAllMocks())

describe('ItemEditModal backdrop click', () => {
  it('does not close the modal when clicking outside it', () => {
    const onClose = vi.fn()
    const { container } = render(
      <ItemEditModal
        item={{ stop_id: 7, kind: 'activity', name: '', details: {} }}
        isNew
        onSave={() => {}}
        onClose={onClose}
      />
    )
    fireEvent.click(container.querySelector('.fixed.inset-0'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('ItemEditModal restaurant Auto-fill', () => {
  it('disables Auto-fill when the name is blank, regardless of saved state', () => {
    render(
      <ItemEditModal
        item={{ stop_id: 7, kind: 'restaurant', name: '', details: {} }}
        isNew
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    const button = screen.getByText('Auto-fill')
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(enrichPlace).not.toHaveBeenCalled()
  })

  it('calls enrichPlace with the stop id and in-progress fields for a not-yet-saved item', async () => {
    enrichPlace.mockResolvedValue({ location: 'Via Roma 1', contact_phone: '+39 123', website: 'https://example.com' })
    render(
      <ItemEditModal
        item={{ stop_id: 7, kind: 'restaurant', name: 'Trattoria', details: {} }}
        isNew
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    const button = screen.getByText('Auto-fill')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    await waitFor(() => expect(enrichPlace).toHaveBeenCalledWith(
      7, { kind: 'restaurant', name: 'Trattoria', location: undefined }
    ))
    expect(await screen.findByDisplayValue('Via Roma 1')).toBeInTheDocument()
  })

  it('still works for an already-saved item, using its stop id', async () => {
    enrichPlace.mockResolvedValue({ location: 'Via Roma 1' })
    getItemStops.mockResolvedValue([])
    render(
      <ItemEditModal
        item={{ id: 42, stop_id: 7, kind: 'restaurant', name: 'Trattoria', details: {} }}
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByText('Auto-fill'))
    await waitFor(() => expect(enrichPlace).toHaveBeenCalledWith(
      7, { kind: 'restaurant', name: 'Trattoria', location: undefined }
    ))
  })
})

describe('ItemEditModal flight booking-primary cost lock', () => {
  it('leaves cost/paid editable when this leg is not part of a shared booking', async () => {
    getItemStops.mockResolvedValue([])
    getBookingPrimary.mockResolvedValue(null)
    render(
      <ItemEditModal
        item={{ id: 42, stop_id: 7, kind: 'flight', name: 'CDG → DOH', cost: '$2,017.50', details: {} }}
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    await waitFor(() => expect(getBookingPrimary).toHaveBeenCalledWith(42))
    expect(screen.getByDisplayValue('$2,017.50')).not.toBeDisabled()
  })

  it('disables cost/paid and shows a hint when an earlier leg on the same booking carries the fare', async () => {
    getItemStops.mockResolvedValue([])
    getBookingPrimary.mockResolvedValue({ id: 41, name: 'CDG → DOH', cost: '$2,017.50' })
    render(
      <ItemEditModal
        item={{ id: 43, stop_id: 7, kind: 'flight', name: 'DOH → PER', cost: '0', details: {} }}
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    await waitFor(() => expect(screen.getByDisplayValue('0')).toBeDisabled())
    expect(screen.getByText(/Tracked on "CDG → DOH"/)).toBeInTheDocument()
  })

  it('does not look up a booking primary for a not-yet-saved item', () => {
    render(
      <ItemEditModal
        item={{ stop_id: 7, kind: 'flight', name: '', details: {} }}
        isNew
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    expect(getBookingPrimary).not.toHaveBeenCalled()
  })
})
