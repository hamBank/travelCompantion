import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn() },
}))

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
  // Unused by these tests — stubbed only because ItemEditModal.jsx (via
  // offlineQueue.js) imports these named exports at module load time.
  updateStop: vi.fn(),
  updatePackItem: vi.fn(),
}))
import { enrichPlace, getItemStops, getBookingPrimary, uploadGpx, createItem } from '../api.js'
import { offlineQueue } from '../offlineQueue.js'
import ItemEditModal, { diffItemChanges } from '../components/ItemEditModal.jsx'

beforeEach(() => vi.clearAllMocks())

describe('diffItemChanges', () => {
  const original = { core: { kind: 'activity', name: 'Old', cost: '', link: '', notes: '', scheduled_at: null }, details: { foo: 'bar' } }

  it('returns no changes when nothing was edited', () => {
    const { changes, base } = diffItemChanges(original, original.core, original.details)
    expect(changes).toEqual({})
    expect(base).toEqual({})
  })

  it('captures only the edited scalar fields, with their original values as base', () => {
    const core = { ...original.core, name: 'New' }
    const { changes, base } = diffItemChanges(original, core, original.details)
    expect(changes).toEqual({ name: 'New' })
    expect(base).toEqual({ name: 'Old' })
  })

  it('captures only the changed details keys, leaving unrelated keys out', () => {
    const details = { foo: 'bar', extra: 'new' }
    const { changes, base } = diffItemChanges(original, original.core, details)
    expect(changes).toEqual({ details: { extra: 'new' } })
    expect(base).toEqual({ details: { extra: undefined } })
  })

  it('detects a changed details value via deep (JSON) equality, not reference equality', () => {
    const orig = { core: original.core, details: { passengers: [{ name: 'A' }] } }
    const details = { passengers: [{ name: 'A' }] }  // same content, new array/object identity
    const { changes } = diffItemChanges(orig, orig.core, details)
    expect(changes).toEqual({})
  })
})

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

describe('ItemEditModal offline Save (routes through the offline queue)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  it('enqueues only the changed fields, with base = the modal-open snapshot, and applies optimistically', async () => {
    getItemStops.mockResolvedValue([])
    const onSave = vi.fn()
    render(
      <ItemEditModal
        item={{ id: 42, stop_id: 7, kind: 'activity', name: 'Pantheon', status: 'pending', cost: '', link: '', notes: '', details: { foo: 'bar' } }}
        onSave={onSave}
        onClose={() => {}}
      />
    )
    fireEvent.change(screen.getByDisplayValue('Pantheon'), { target: { value: 'Pantheon (renamed)' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(offlineQueue.enqueue).toHaveBeenCalledWith({
      entity: 'item', entityId: 42,
      changes: { name: 'Pantheon (renamed)' },
      base: { name: 'Pantheon' },
    }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 42, name: 'Pantheon (renamed)' }))
  })

  it('does not enqueue anything when nothing changed', async () => {
    getItemStops.mockResolvedValue([])
    const onSave = vi.fn()
    render(
      <ItemEditModal
        item={{ id: 42, stop_id: 7, kind: 'activity', name: 'Pantheon', details: {} }}
        onSave={onSave}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(offlineQueue.enqueue).not.toHaveBeenCalled()
  })

  it('blocks a stop move while offline instead of queueing it (moves are out of scope for the queue)', async () => {
    getItemStops.mockResolvedValue([
      { id: 7, location: 'Rome' },
      { id: 8, location: 'Florence' },
    ])
    const onSave = vi.fn()
    render(
      <ItemEditModal
        item={{ id: 42, stop_id: 7, kind: 'activity', name: 'Pantheon', details: {} }}
        onSave={onSave}
        onClose={() => {}}
      />
    )
    await screen.findByText('Move to stop')
    fireEvent.change(screen.getByDisplayValue('Rome (current)'), { target: { value: '8' } })
    fireEvent.click(screen.getByText('Save'))

    expect(await screen.findByText(/internet connection/)).toBeInTheDocument()
    expect(offlineQueue.enqueue).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('ItemEditModal GPX upload on a not-yet-saved cycling card', () => {
  function pickGpx() {
    const file = new File(['<gpx></gpx>'], 'ride.gpx', { type: 'application/gpx+xml' })
    const input = document.querySelector('input[accept=".gpx,application/gpx+xml"]')
    fireEvent.change(input, { target: { files: [file] } })
    return file
  }

  it('defers the upload instead of calling the endpoint with no item id', async () => {
    render(
      <ItemEditModal
        item={{ stop_id: 7, kind: 'cycling', name: 'Loire loop', details: {} }}
        isNew
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    pickGpx()
    // The pre-fix behavior: uploadGpx(undefined, file) → 422 "unable to
    // parse string as an integer". Now it must not be called at all yet.
    expect(uploadGpx).not.toHaveBeenCalled()
    expect(await screen.findByText(/will upload when saved/)).toBeInTheDocument()
  })

  it('uploads the held file right after Save creates the item', async () => {
    createItem.mockResolvedValue({ id: 91, stop_id: 7, kind: 'cycling', name: 'Loire loop', details: {} })
    uploadGpx.mockResolvedValue({ id: 91, stop_id: 7, kind: 'cycling', name: 'Loire loop', details: { gpx_filename: 'x.gpx' } })
    const onSave = vi.fn()
    render(
      <ItemEditModal
        item={{ stop_id: 7, kind: 'cycling', name: 'Loire loop', details: {} }}
        isNew
        onSave={onSave}
        onClose={() => {}}
      />
    )
    const file = pickGpx()
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(uploadGpx).toHaveBeenCalledWith(91, file))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 91, details: { gpx_filename: 'x.gpx' } }))
  })

  it('still uploads immediately for an already-saved card', async () => {
    getItemStops.mockResolvedValue([])
    uploadGpx.mockResolvedValue({ id: 42, details: { gpx_filename: 'ride.gpx' } })
    render(
      <ItemEditModal
        item={{ id: 42, stop_id: 7, kind: 'cycling', name: 'Loire loop', details: {} }}
        onSave={() => {}}
        onClose={() => {}}
      />
    )
    const file = pickGpx()
    await waitFor(() => expect(uploadGpx).toHaveBeenCalledWith(42, file))
  })
})
