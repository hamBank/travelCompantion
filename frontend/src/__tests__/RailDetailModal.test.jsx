import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  updateItem: vi.fn(),
  updateItemStatus: vi.fn(),
  deleteItem: vi.fn(),
  // AttachmentsSection (mounted via ItemDetailModal.jsx, now shared with
  // RailDetailModal) fetches its own list on mount.
  listAttachments: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(), deleteAttachment: vi.fn(), fetchAttachmentBlob: vi.fn(),
  // Unused by these tests — stubbed only because offlineQueue.js (imported
  // by DetailActions.jsx) reads these named exports at module load time.
  updateStop: vi.fn(),
  updatePackItem: vi.fn(),
}))

import { updateItemStatus, listAttachments } from '../api.js'
import RailDetailModal from '../components/RailDetailModal.jsx'

// A non-"mobigo" operator would mount RailCheckPanel, which calls the real
// global fetch directly (not through api.js) against live rail-data hosts —
// avoid that entirely in these tests by using an operator RailDetailModal's
// own /mobigo/i check treats as "skip the live-check panel".
function baseItem(details) {
  return { id: 1, kind: 'rail', name: 'Train', details: { operator: 'Mobigo Rail', ...details } }
}

describe('RailDetailModal — attachments + needs-booking chip', () => {
  it('renders an existing attachment', async () => {
    listAttachments.mockResolvedValue([{ id: 1, filename: 'e-ticket.pdf', size: 1024 }])
    render(<RailDetailModal item={baseItem({ train_number: 'IC5' })} onClose={() => {}} />)
    expect(await screen.findByText(/e-ticket\.pdf/)).toBeInTheDocument()
  })

  it('shows the needs-booking chip with a book-by date', () => {
    render(
      <RailDetailModal
        item={baseItem({ train_number: 'IC5', needs_booking: true, book_by: '2026-08-01' })}
        onClose={() => {}}
      />
    )
    expect(screen.getByText(/Needs booking/)).toBeInTheDocument()
    expect(screen.getByText(/book by/)).toBeInTheDocument()
  })

  it('does not show the needs-booking chip when unset', () => {
    render(<RailDetailModal item={baseItem({ train_number: 'IC5' })} onClose={() => {}} />)
    expect(screen.queryByText(/Needs booking/)).not.toBeInTheDocument()
  })
})

describe('RailDetailModal — status toggle', () => {
  it('shows a Done control wired to the item', async () => {
    updateItemStatus.mockResolvedValue({})
    render(
      <RailDetailModal
        item={{ id: 1, kind: 'rail', name: 'Train', details: { operator: 'Mobigo Rail', train_number: 'IC5' }, status: 'pending' }}
        onClose={() => {}}
      />
    )
    const btn = screen.getByRole('button', { name: 'Done' })
    fireEvent.click(btn)
    await waitFor(() => expect(updateItemStatus).toHaveBeenCalledWith(1, 'done'))
    expect(await screen.findByRole('button', { name: 'Pending' })).toBeInTheDocument()
  })
})
