import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PackingList, { isPacked, isShared } from '../components/PackingList.jsx'
import * as api from '../api.js'

vi.mock('../api.js')

const DATA = {
  bags: [{ id: 1, trip_id: 9, name: 'Carry-on' }],
  items: [
    { id: 10, trip_id: 9, name: 'Socks', owner_email: 'me@x.com', bag_id: 1, quantity: 5, packed_count: 3 },
    { id: 11, trip_id: 9, name: 'Tent', owner_email: '', bag_id: null, quantity: 1, packed_count: 1 },
  ],
  counts: { total: 6, packed: 4 },
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getPacking.mockResolvedValue(DATA)
  api.updatePackItem.mockResolvedValue({})
})

describe('isPacked / isShared', () => {
  it('isPacked true only when packed_count covers quantity', () => {
    expect(isPacked({ packed_count: 5, quantity: 5 })).toBe(true)
    expect(isPacked({ packed_count: 3, quantity: 5 })).toBe(false)
  })
  it('isShared true when no owner_email', () => {
    expect(isShared({ owner_email: '' })).toBe(true)
    expect(isShared({ owner_email: 'a@b.com' })).toBe(false)
  })
})

describe('PackingList', () => {
  it('shows the packed/total summary', async () => {
    render(<PackingList tripId={9} userEmail="me@x.com" canEdit />)
    expect(await screen.findByText(/4 \/ 6 packed/)).toBeTruthy()
  })

  it('marks shared items with a Shared badge', async () => {
    render(<PackingList tripId={9} userEmail="me@x.com" canEdit />)
    await screen.findByText('Tent')
    expect(screen.getByText('Shared')).toBeTruthy()   // Tent is shared (distinct from form's "shared" label)
  })

  it('toggling an unpacked item packs it fully', async () => {
    // canEdit=false removes the form's shared checkbox, leaving only item checkboxes
    render(<PackingList tripId={9} userEmail="me@x.com" canEdit={false} />)
    await screen.findByText('Socks')
    const checkboxes = screen.getAllByRole('checkbox')   // [Socks unchecked, Tent checked]
    const socksCb = checkboxes.find(cb => !cb.checked)
    fireEvent.click(socksCb)
    await waitFor(() => expect(api.updatePackItem).toHaveBeenCalledWith(10, { packed_count: 5 }))
  })
})
