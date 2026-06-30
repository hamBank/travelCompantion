import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PackItemEditModal from '../components/PackItemEditModal.jsx'

const item = { id: 10, name: 'Socks', owner_email: 'me@x.com', bag_id: null, quantity: 5, packed_count: 3 }
const bags = [{ id: 1, name: 'Carry-on' }]

describe('PackItemEditModal', () => {
  it('saves an updated quantity', async () => {
    const onSave = vi.fn().mockResolvedValue({})
    render(<PackItemEditModal item={item} bags={bags} canEdit onSave={onSave} onDelete={() => {}} onClose={() => {}} />)
    const qty = screen.getByLabelText('Quantity')
    fireEvent.change(qty, { target: { value: '8' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(10, expect.objectContaining({ quantity: 8, packed_count: 3 })))
  })

  it('clamps packed to quantity on save', async () => {
    const onSave = vi.fn().mockResolvedValue({})
    render(<PackItemEditModal item={item} bags={bags} canEdit onSave={onSave} onDelete={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('Packed'), { target: { value: '99' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(10, expect.objectContaining({ quantity: 5, packed_count: 5 })))
  })

  it('hides the shared toggle when canEdit is false', () => {
    render(<PackItemEditModal item={item} bags={bags} canEdit={false} onSave={() => {}} onDelete={() => {}} onClose={() => {}} />)
    expect(screen.queryByText(/Shared/)).toBeNull()
  })
})
