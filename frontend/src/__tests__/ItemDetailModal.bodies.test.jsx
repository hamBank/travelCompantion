import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../api.js', () => ({
  fetchGpxText: vi.fn().mockResolvedValue(null),
  downloadGpx: vi.fn(),
  fetchRiverMapBlob: vi.fn().mockResolvedValue(null),
  listAttachments: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(), deleteAttachment: vi.fn(), fetchAttachmentBlob: vi.fn(),
  updateItemStatus: vi.fn(), deleteItem: vi.fn(),
  // offlineQueue.js (imported via DetailActions) reads these named exports
  // at module load time — unused by these tests but must be present.
  updateItem: vi.fn(), updateStop: vi.fn(), updatePackItem: vi.fn(),
}))

import ItemDetailModal from '../components/ItemDetailModal.jsx'

/**
 * Regression coverage for the audit finding: walk/transfer/tour cards open
 * ItemDetailModal but matched no kind-specific body branch, so every field
 * their edit forms can store (a tour's meeting point, a walk's GPX
 * stats, a transfer's booking ref) rendered nowhere in the detail view.
 * Asserts on specific fields (not a snapshot) so a future regression that
 * silently drops a field fails this suite, same as FlightDetailModal.test.jsx.
 */

describe('ItemDetailModal — WalkBody', () => {
  it('renders route, difficulty, stats, duration, and description', () => {
    const item = {
      id: 1, kind: 'walk', name: 'Coastal trail', status: 'pending', notes: '',
      details: {
        start_location: 'Cinque Terre trailhead', end_location: 'Vernazza',
        difficulty: 'moderate', distance: '12 km', elevation_gain: '450m',
        elevation_loss: '300m', duration: '4h',
        description: 'Scenic coastal path with sea views',
      },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.getByText('Cinque Terre trailhead → Vernazza')).toBeInTheDocument()
    expect(screen.getByText('moderate')).toBeInTheDocument()
    expect(screen.getByText(/12 km/)).toBeInTheDocument()
    expect(screen.getByText(/↑ 450m/)).toBeInTheDocument()
    expect(screen.getByText(/↓ 300m/)).toBeInTheDocument()
    expect(screen.getByText('4h')).toBeInTheDocument()
    expect(screen.getByText('Scenic coastal path with sea views')).toBeInTheDocument()
  })

  it('renders no stray labels for an empty details object', () => {
    const item = { id: 2, kind: 'walk', name: 'Empty walk', status: 'pending', notes: '', details: {} }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.queryByText('Route')).not.toBeInTheDocument()
    expect(screen.queryByText('Difficulty')).not.toBeInTheDocument()
    expect(screen.queryByText('Stats')).not.toBeInTheDocument()
    expect(screen.queryByText('Duration')).not.toBeInTheDocument()
  })
})

describe('ItemDetailModal — TransferBody', () => {
  it('renders route, vehicle, provider, and booking ref', () => {
    const item = {
      id: 3, kind: 'transfer', name: 'Airport transfer', status: 'pending', notes: '',
      details: {
        start_location: 'Fiumicino Airport', end_location: 'Hotel Roma',
        vehicle_type: 'car', provider: 'Rome Shuttle Co', booking_ref: 'TR-9821',
      },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.getByText('Fiumicino Airport → Hotel Roma')).toBeInTheDocument()
    expect(screen.getByText('car')).toBeInTheDocument()
    expect(screen.getByText('Rome Shuttle Co')).toBeInTheDocument()
    expect(screen.getByText('TR-9821')).toBeInTheDocument()
  })
})

describe('ItemDetailModal — TourBody', () => {
  it('renders meeting point as a maps link, operator, language, and group size', () => {
    const item = {
      id: 4, kind: 'tour', name: 'Colosseum tour', status: 'pending', notes: '',
      details: {
        meeting_point: 'Colosseum main gate', operator: 'Rome Walks',
        language: 'English', group_size: '12',
      },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    const link = screen.getByText('Colosseum main gate')
    expect(link.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining(encodeURIComponent('Colosseum main gate'))
    )
    expect(screen.getByText('Rome Walks')).toBeInTheDocument()
    expect(screen.getByText('English')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })
})
