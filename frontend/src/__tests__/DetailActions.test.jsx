import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  updateItemStatus: vi.fn(),
  deleteItem: vi.fn(),
  // Unused by these tests — stubbed only because offlineQueue.js (imported
  // by DetailActions.jsx) reads these named exports at module load time.
  updateItem: vi.fn(),
  updateStop: vi.fn(),
  updatePackItem: vi.fn(),
}))
vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn() },
}))

import { updateItemStatus } from '../api.js'
import { offlineQueue } from '../offlineQueue.js'
import DetailActions from '../components/DetailActions.jsx'
import { RoleContext, RealRoleContext } from '../roles.js'

// The collapsed card's leading icon already toggles pending/done (StopCard.jsx's
// CardIcon), but that's easy to miss — this is the same control's home inside
// the detail view, added directly in response to "flight cards don't seem to
// have a way of changing the pending status" (the gap exists for every kind's
// detail modal, not just flights, since they all share this component).
describe('DetailActions — status toggle', () => {
  afterEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  it('shows "Mark done" for a pending item and calls updateItemStatus + onStatusChange on click', async () => {
    updateItemStatus.mockResolvedValue({})
    const onStatusChange = vi.fn()
    render(
      <DetailActions item={{ id: 1, status: 'pending' }} onStatusChange={onStatusChange} />
    )
    const btn = screen.getByRole('button', { name: /Mark done/ })
    fireEvent.click(btn)
    await waitFor(() => expect(updateItemStatus).toHaveBeenCalledWith(1, 'done'))
    expect(onStatusChange).toHaveBeenCalledWith({ id: 1, status: 'done' })
    expect(offlineQueue.enqueue).not.toHaveBeenCalled()
  })

  it('shows "Mark pending" for a done item and toggles back to pending', async () => {
    updateItemStatus.mockResolvedValue({})
    const onStatusChange = vi.fn()
    render(
      <DetailActions item={{ id: 2, status: 'done' }} onStatusChange={onStatusChange} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Mark pending/ }))
    await waitFor(() => expect(updateItemStatus).toHaveBeenCalledWith(2, 'pending'))
    expect(onStatusChange).toHaveBeenCalledWith({ id: 2, status: 'pending' })
  })

  it('does not render the toggle when onStatusChange is not provided', () => {
    render(<DetailActions item={{ id: 3, status: 'pending' }} />)
    expect(screen.queryByRole('button', { name: /Mark done/ })).not.toBeInTheDocument()
  })

  it('does not render the toggle for a viewer (no edit rights)', () => {
    render(
      <RoleContext.Provider value="viewer">
        <DetailActions item={{ id: 4, status: 'pending' }} onStatusChange={vi.fn()} onHistory={vi.fn()} />
      </RoleContext.Provider>
    )
    expect(screen.queryByRole('button', { name: /Mark done/ })).not.toBeInTheDocument()
  })

  it('routes through the offline queue (not a direct PATCH) while offline for a real editor', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    offlineQueue.enqueue.mockResolvedValue({})
    const onStatusChange = vi.fn()
    render(
      // Offline forces the *effective* role to viewer app-wide, but the real
      // trip role (RealRoleContext) still governs queueable affordances.
      <RoleContext.Provider value="viewer">
        <RealRoleContext.Provider value="owner">
          <DetailActions item={{ id: 5, status: 'pending' }} onStatusChange={onStatusChange} />
        </RealRoleContext.Provider>
      </RoleContext.Provider>
    )
    const btn = screen.getByRole('button', { name: /Mark done/ })
    fireEvent.click(btn)
    await waitFor(() => expect(offlineQueue.enqueue).toHaveBeenCalledWith({
      entity: 'item', entityId: 5, changes: { status: 'done' }, base: { status: 'pending' },
    }))
    expect(updateItemStatus).not.toHaveBeenCalled()
    expect(onStatusChange).toHaveBeenCalledWith({ id: 5, status: 'done' })
  })
})
