import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BagEditModal, { descendantIds } from '../components/BagEditModal.jsx'

const bags = [
  { id: 1, name: 'Suitcase', parent_id: null },
  { id: 2, name: 'Cube', parent_id: 1 },
  { id: 3, name: 'Pouch', parent_id: 2 },
  { id: 4, name: 'Backpack', parent_id: null },
]

describe('descendantIds', () => {
  it('collects all nested descendants', () => {
    expect(descendantIds(1, bags)).toEqual(new Set([2, 3]))
    expect(descendantIds(4, bags)).toEqual(new Set())
  })
})

describe('BagEditModal', () => {
  it('excludes self and descendants from the parent choices', () => {
    render(<BagEditModal bag={bags[0]} bags={bags} onSave={() => {}} onDelete={() => {}} onClose={() => {}} />)
    const opts = Array.from(screen.getByRole('combobox').options).map(o => o.text)
    // Suitcase (self), Cube, Pouch (descendants) excluded; only Backpack + top-level option
    expect(opts).toContain('Backpack')
    expect(opts).not.toContain('Suitcase')
    expect(opts).not.toContain('Cube')
    expect(opts).not.toContain('Pouch')
  })

  it('saves the chosen parent', async () => {
    const onSave = vi.fn().mockResolvedValue({})
    render(<BagEditModal bag={bags[1]} bags={bags} onSave={onSave} onDelete={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(2, { name: 'Cube', parent_id: 4 }))
  })
})
