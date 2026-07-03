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
  localStorage.clear()
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

  it('collapses a bag group, hiding its items', async () => {
    render(<PackingList tripId={9} userEmail="me@x.com" canEdit />)
    expect(await screen.findByText('Socks')).toBeTruthy()       // Carry-on item visible
    fireEvent.click(screen.getByText('🧳 Carry-on'))            // collapse via the bag header
    await waitFor(() => expect(screen.queryByText('Socks')).toBeNull())
    expect(screen.getByText('Tent')).toBeTruthy()               // other group unaffected
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

  it('marks the hover-reveal edit and move-to-bag controls with edit-btn, so the app-wide touch-device CSS forces them visible', async () => {
    // Regression: these relied only on group-hover/focus, which a touchscreen
    // can never trigger — every other hover-reveal control in the app opts
    // into the `@media (hover: none) { .edit-btn { opacity: 1 } }` override
    // via this class; PackingList's controls didn't, so they stayed
    // permanently invisible on touch devices like an iPhone.
    render(<PackingList tripId={9} userEmail="me@x.com" canEdit />)
    await screen.findByText('Socks')
    const editButtons = screen.getAllByTitle('Edit')
    expect(editButtons.length).toBeGreaterThan(0)
    for (const btn of editButtons) expect(btn).toHaveClass('edit-btn')
    const moveSelects = screen.getAllByTitle('Move to bag')
    expect(moveSelects.length).toBeGreaterThan(0)
    for (const sel of moveSelects) expect(sel).toHaveClass('edit-btn')
  })

  it('only reserves the counts/shared columns\' fixed width on wider screens, and floors the name width, so long rows don\'t squeeze the item name to invisible on a phone', async () => {
    // Regression: those columns used to reserve 5rem/4.5rem via inline style
    // unconditionally, even empty — on a narrow viewport that alone could
    // squeeze the name span (flex-1, was min-w-0) down to zero width.
    render(<PackingList tripId={9} userEmail="me@x.com" canEdit />)
    const name = await screen.findByText('Socks')
    expect(name).toHaveClass('min-w-[2.5rem]')
    expect(name).not.toHaveClass('min-w-0')

    const countsCol = name.nextElementSibling
    expect(countsCol.className).toContain('sm:w-20')
    expect(countsCol.className).not.toMatch(/(?<!sm:)\bw-20\b/)

    const sharedCol = countsCol.nextElementSibling
    expect(sharedCol.className).toContain(`sm:w-[4.5rem]`)
  })
})
