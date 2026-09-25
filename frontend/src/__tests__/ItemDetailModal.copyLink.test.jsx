import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../api.js', () => ({
  fetchGpxText: vi.fn().mockResolvedValue(null),
  downloadGpx: vi.fn(),
  fetchRiverMapBlob: vi.fn().mockResolvedValue(null),
  listAttachments: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(), deleteAttachment: vi.fn(), fetchAttachmentBlob: vi.fn(),
  updateItemStatus: vi.fn(), deleteItem: vi.fn(),
  updateItem: vi.fn(), updateStop: vi.fn(), updatePackItem: vi.fn(),
}))

import ItemDetailModal from '../components/ItemDetailModal.jsx'

const ITEM = { id: 13, kind: 'activity', name: 'Museum visit', status: 'pending', notes: '', details: {} }

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue() } })
})

describe('ItemDetailModal — copy link', () => {
  it('copies /t/:tripId/item/:itemId to the clipboard when tripId is given', () => {
    render(<ItemDetailModal item={ITEM} onClose={() => {}} tripId={7} />)
    fireEvent.click(screen.getByTitle('Copy link to this item'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/t/7/item/13'))
  })

  it('is not shown at all when no tripId is given', () => {
    render(<ItemDetailModal item={ITEM} onClose={() => {}} />)
    expect(screen.queryByTitle('Copy link to this item')).toBeNull()
  })
})
