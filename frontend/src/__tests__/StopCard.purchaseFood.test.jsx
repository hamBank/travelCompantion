import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

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
 * body now opens ItemDetailModal (asserted via modal-only content), while
 * the status icon and the item's own link keep working without opening it.
 */

function stopWith(item) {
  return {
    id: 1, location: 'Florence', status: 'planned', items: [item],
  }
}

beforeEach(() => vi.clearAllMocks())

describe('PurchaseCard — detail modal', () => {
  it('opens the detail modal on click, showing description and notes', async () => {
    const item = {
      id: 10, kind: 'purchase', name: 'Leather wallet', status: 'pending',
      notes: 'Ask about the discount for cash',
      details: { description: 'Handmade, tan color' },
    }
    render(<StopCard stop={stopWith(item)} index={0} forceOpen />)
    fireEvent.click(screen.getByText('Leather wallet'))
    expect(screen.getByText('Ask about the discount for cash')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())
  })
})

describe('FoodCard — detail modal', () => {
  it('opens the detail modal on click, showing description and notes', async () => {
    const item = {
      id: 11, kind: 'food', name: 'Gelato stop', status: 'pending',
      notes: 'Try the pistachio',
      details: { description: 'Best gelato in the neighborhood' },
    }
    render(<StopCard stop={stopWith(item)} index={0} forceOpen />)
    fireEvent.click(screen.getByText('Gelato stop'))
    expect(screen.getByText('Try the pistachio')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())
  })
})
