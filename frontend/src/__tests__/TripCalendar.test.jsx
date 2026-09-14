import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TripCalendar from '../components/TripCalendar.jsx'

// 2026-09-14 is a Monday — a range anchored there needs no leading padding,
// keeping the week-boundary math in these tests easy to reason about.
function makeItem(overrides) {
  return { id: 1, kind: 'activity', name: 'Item', status: 'pending', scheduled_at: null, details: {}, ...overrides }
}

describe('TripCalendar', () => {
  it('renders one band per dated stop with gridColumn spanning the right columns', () => {
    const timeline = {
      start_date: '2026-09-14', end_date: '2026-09-15',
      stops: [
        { id: 1, location: 'Tokyo', country: 'Japan', arrive: '2026-09-14T10:00', depart: '2026-09-15T10:00', items: [] },
      ],
    }
    render(<TripCalendar timeline={timeline} view="week" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    const bands = screen.getAllByTestId('stop-band')
    expect(bands).toHaveLength(1)
    // Mon=col1 .. Tue=col2, so a Mon-Tue band spans grid columns "1 / 3".
    expect(bands[0].style.gridColumn).toBe('1 / 3')
  })

  it('a stop crossing a week boundary renders as two segments', () => {
    // 2026-09-14 (Mon) week 1 ends Sun 2026-09-20; week 2 starts Mon 2026-09-21.
    const timeline = {
      start_date: '2026-09-19', end_date: '2026-09-22',
      stops: [
        { id: 1, location: 'Kyoto', country: 'Japan', arrive: '2026-09-19T10:00', depart: '2026-09-22T10:00', items: [] },
      ],
    }
    render(<TripCalendar timeline={timeline} view="trip" onOpenDay={() => {}} onOpenItem={() => {}} />)
    const bands = screen.getAllByTestId('stop-band')
    expect(bands).toHaveLength(2)
  })

  it('chip click calls onOpenItem with the item; date-number click calls onOpenDay', () => {
    const item = makeItem({ id: 42, name: 'Museum visit', kind: 'activity', scheduled_at: '2026-09-14T09:00' })
    const timeline = { start_date: '2026-09-14', end_date: '2026-09-14', stops: [{ id: 1, location: 'Tokyo', arrive: '2026-09-14T00:00', depart: '2026-09-14T00:00', items: [item] }] }
    const onOpenItem = vi.fn()
    const onOpenDay = vi.fn()
    render(<TripCalendar timeline={timeline} view="week" anchorDay="2026-09-14" onOpenDay={onOpenDay} onOpenItem={onOpenItem} />)

    fireEvent.click(screen.getByText('Museum visit'))
    expect(onOpenItem).toHaveBeenCalledWith(item)

    fireEvent.click(screen.getByRole('button', { name: 'Open 2026-09-14' }))
    expect(onOpenDay).toHaveBeenCalledWith('2026-09-14')
  })

  it('"+N more" appears when a day has more than 4 chips', () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem({ id: i + 1, name: `Item ${i + 1}`, scheduled_at: `2026-09-14T0${i}:00` }))
    const timeline = { start_date: '2026-09-14', end_date: '2026-09-14', stops: [{ id: 1, location: 'Tokyo', arrive: null, depart: null, items }] }
    render(<TripCalendar timeline={timeline} view="month" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    expect(screen.getByText('+2 more')).toBeTruthy()
  })

  it('does not cap chips in week view (no "+N more")', () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem({ id: i + 1, name: `Item ${i + 1}`, scheduled_at: `2026-09-14T0${i}:00` }))
    const timeline = { start_date: '2026-09-14', end_date: '2026-09-14', stops: [{ id: 1, location: 'Tokyo', arrive: null, depart: null, items }] }
    render(<TripCalendar timeline={timeline} view="week" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    expect(screen.queryByText(/more/)).toBeNull()
    expect(screen.getByText('Item 6')).toBeTruthy()
  })

  it('empty timeline shows empty-state text and no grid', () => {
    render(<TripCalendar timeline={{ start_date: null, end_date: null, stops: [] }} view="trip" onOpenDay={() => {}} onOpenItem={() => {}} />)
    expect(screen.getByText('Nothing in this trip has a date yet.')).toBeTruthy()
    expect(screen.queryAllByTestId('week-row')).toHaveLength(0)
  })

  it('lists undated stops separately, not as a band', () => {
    const timeline = {
      start_date: '2026-09-14', end_date: '2026-09-14',
      stops: [
        { id: 1, location: 'Tokyo', arrive: '2026-09-14T10:00', depart: '2026-09-14T10:00', items: [] },
        { id: 2, location: 'TBD Side Trip', arrive: null, depart: null, items: [] },
      ],
    }
    render(<TripCalendar timeline={timeline} view="week" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    expect(screen.getByText('Undated stops')).toBeTruthy()
    expect(screen.getByText('TBD Side Trip')).toBeTruthy()
    expect(screen.queryAllByTestId('stop-band')).toHaveLength(1) // only the dated stop got a band
  })
})
