import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

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

// Purchase and food previously had no detail modal at all, so item.notes —
// entered in the edit form for every kind — rendered nowhere for them.
describe('ItemDetailModal — PurchaseFoodBody', () => {
  it('renders location (as a maps link), description, link, cost, and notes for a purchase', () => {
    const item = {
      id: 5, kind: 'purchase', name: 'Leather wallet', status: 'pending',
      notes: 'Ask about the discount for cash',
      link: 'https://example.com/wallet',
      cost: '€45',
      details: { location: 'Florence leather market', description: 'Handmade, tan color' },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    const link = screen.getByText('Florence leather market')
    expect(link.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining(encodeURIComponent('Florence leather market'))
    )
    expect(screen.getByText('Handmade, tan color')).toBeInTheDocument()
    expect(screen.getByText('https://example.com/wallet')).toBeInTheDocument()
    expect(screen.getByText('Ask about the discount for cash')).toBeInTheDocument()
  })

  it('renders description and notes for a food item (no location row)', () => {
    const item = {
      id: 6, kind: 'food', name: 'Gelato stop', status: 'pending',
      notes: 'Try the pistachio',
      details: { description: 'Best gelato in the neighborhood' },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.getByText('Best gelato in the neighborhood')).toBeInTheDocument()
    expect(screen.getByText('Try the pistachio')).toBeInTheDocument()
    expect(screen.queryByText('Where')).not.toBeInTheDocument()
  })
})

// opening_hours is stored on activity/show/restaurant/tour items but was
// only ever *consumed* (ClosedChip's closed-venue warning), never shown.
describe('ItemDetailModal — HoursRow', () => {
  const HOURS = [
    'Monday: 9:00 AM – 5:00 PM',
    'Tuesday: 9:00 AM – 5:00 PM',
    'Wednesday: 9:00 AM – 5:00 PM',
    'Thursday: 9:00 AM – 5:00 PM',
    'Friday: 9:00 AM – 5:00 PM',
    'Saturday: 10:00 AM – 2:00 PM',
    'Sunday: Closed',
  ]

  it('highlights the item day and expands to show all lines on click', () => {
    // 2026-08-05 is a Wednesday -> Monday-first index 2.
    const item = {
      id: 7, kind: 'activity', name: 'Museum visit', status: 'pending', notes: '',
      scheduled_at: '2026-08-05T10:00:00',
      details: { opening_hours: HOURS },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.getByText(/Wednesday: 9:00 AM/)).toBeInTheDocument()
    expect(screen.queryByText(/Sunday: Closed/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('All hours'))
    expect(screen.getByText(/Sunday: Closed/)).toBeInTheDocument()
  })

  it('renders legacy string hours as-is', () => {
    const item = {
      id: 8, kind: 'restaurant', name: 'Trattoria', status: 'pending', notes: '',
      details: { opening_hours: 'Daily 12pm-11pm' },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.getByText('Daily 12pm-11pm')).toBeInTheDocument()
  })

  it('renders no Hours label for a malformed array', () => {
    const item = {
      id: 9, kind: 'show', name: 'Opera', status: 'pending', notes: '',
      details: { opening_hours: ['Mon: 9-5', 'Tue: 9-5'] },
    }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.queryByText('Hours')).not.toBeInTheDocument()
  })
})

describe('ItemDetailModal — NoteBody important badge', () => {
  it('renders the Important badge when set', () => {
    const item = { id: 10, kind: 'note', name: 'Reminder', status: 'pending', notes: 'Bring passport', details: { important: true } }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.getByText('⚠ Important')).toBeInTheDocument()
  })

  it('does not render the badge when unset', () => {
    const item = { id: 11, kind: 'note', name: 'Reminder', status: 'pending', notes: 'Bring passport', details: {} }
    render(<ItemDetailModal item={item} onClose={() => {}} />)
    expect(screen.queryByText('⚠ Important')).not.toBeInTheDocument()
  })
})
