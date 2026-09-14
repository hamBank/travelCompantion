import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../api.js', () => ({
  updateStopStatus: vi.fn(), updateItemStatus: vi.fn(), getWeather: vi.fn(),
  fetchRiverMapBlob: vi.fn(), fetchGpxMapBlob: vi.fn(), fetchDayMapBlob: vi.fn(),
  fetchGpxText: vi.fn().mockResolvedValue(null),
  downloadGpx: vi.fn(),
  listAttachments: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(), deleteAttachment: vi.fn(), fetchAttachmentBlob: vi.fn(),
  deleteItem: vi.fn(),
  // Unused by these tests — stubbed only because StopCard.jsx (via
  // offlineQueue.js/ItemEditModal.jsx) imports these named exports at
  // module load time.
  updateItem: vi.fn(), updateStop: vi.fn(), updatePackItem: vi.fn(),
}))

import StopCard from '../components/StopCard.jsx'

/**
 * Purchase and food cards previously had no detail modal at all — clicking
 * the card body did nothing. Regression coverage: tapping either card's
 * body now calls `onOpen` with the item.
 *
 * Since plan-18b, StopCard's cards no longer own a detail modal instance
 * each — opening one is unified onto TripTimeline's single nav-modal
 * mechanism (so Back can close it), reached via the `onOpen` prop StopCard
 * threads down to every card. StopCard itself is tested here in isolation
 * (no TripTimeline/nav wiring), so it only asserts the hand-off happens —
 * the modal's own content is covered by ItemDetailModal's own tests.
 */

function stopWith(item) {
  return {
    id: 1, location: 'Florence', status: 'planned', items: [item],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('PurchaseCard — detail modal', () => {
  it('calls onOpen with the item on click', () => {
    const item = {
      id: 10, kind: 'purchase', name: 'Leather wallet', status: 'pending',
      notes: 'Ask about the discount for cash',
      details: { description: 'Handmade, tan color' },
    }
    const onOpen = vi.fn()
    render(<StopCard stop={stopWith(item)} index={0} forceOpen onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Leather wallet'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }))
  })
})

describe('FoodCard — detail modal', () => {
  it('calls onOpen with the item on click', () => {
    const item = {
      id: 11, kind: 'food', name: 'Gelato stop', status: 'pending',
      notes: 'Try the pistachio',
      details: { description: 'Best gelato in the neighborhood' },
    }
    const onOpen = vi.fn()
    render(<StopCard stop={stopWith(item)} index={0} forceOpen onOpen={onOpen} />)
    fireEvent.click(screen.getByText('Gelato stop'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 11 }))
  })
})
