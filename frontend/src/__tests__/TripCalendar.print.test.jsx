import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TripCalendar from '../components/TripCalendar.jsx'

/**
 * Plan-16c: the print-only title block (trip name + printed range), and the
 * "all chips stay in the DOM always" rule that lets the on-screen "+N more"
 * truncation be pure CSS (`.cal-capped`) rather than a `matchMedia('print')`
 * branch — so print (which never applies that screen-only CSS) shows every
 * chip with no JS involved. See index.css's `@media print` block for the
 * other half of this (untestable in jsdom, verified manually per the PR).
 */
function makeItem(overrides) {
  return { id: 1, kind: 'activity', name: 'Item', status: 'pending', scheduled_at: null, details: {}, ...overrides }
}

describe('TripCalendar print', () => {
  it('renders a print-only title block with the trip name and the header range', () => {
    const timeline = {
      name: 'Japan Trip', start_date: '2026-09-14', end_date: '2026-09-14',
      stops: [{ id: 1, location: 'Tokyo', arrive: '2026-09-14T10:00', depart: '2026-09-14T10:00', items: [] }],
    }
    render(<TripCalendar timeline={timeline} view="week" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    expect(screen.getByText('Japan Trip')).toBeTruthy()
    // The same header range text appears twice — once in the print-only
    // block, once in the (print-hidden) on-screen heading. ("Sep"/"Sept"
    // abbreviation varies with the ICU data available to the test runner.)
    expect(screen.getAllByText(/14 Sept? – 20 Sept? 2026/).length).toBeGreaterThan(0)
    expect(screen.getByText(/printed/)).toBeTruthy()
  })

  it('all chips are in the DOM even when a day has more than 4 (screen truncation is CSS-only)', () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem({ id: i + 1, name: `Item ${i + 1}`, scheduled_at: `2026-09-14T0${i}:00` }))
    const timeline = { name: 'Big Day Trip', start_date: '2026-09-14', end_date: '2026-09-14', stops: [{ id: 1, location: 'Tokyo', arrive: null, depart: null, items }] }
    render(<TripCalendar timeline={timeline} view="month" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    // The screen-only overflow control is still there…
    expect(screen.getByText('+2 more')).toBeTruthy()
    // …but every chip, including the ones a screen would visually hide via
    // `.cal-capped .cal-chip:nth-child(n+5)`, is present in the DOM.
    for (let i = 1; i <= 6; i++) {
      expect(screen.getByText(`Item ${i}`)).toBeTruthy()
    }
  })

  it('week view never gets the cal-capped class (matches the existing no-cap behaviour)', () => {
    const items = Array.from({ length: 6 }, (_, i) => makeItem({ id: i + 1, name: `Item ${i + 1}`, scheduled_at: `2026-09-14T0${i}:00` }))
    const timeline = { name: 'Week Trip', start_date: '2026-09-14', end_date: '2026-09-14', stops: [{ id: 1, location: 'Tokyo', arrive: null, depart: null, items }] }
    render(<TripCalendar timeline={timeline} view="week" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    expect(screen.queryByText(/more/)).toBeNull()
    const dayItems = document.querySelector('.cal-day-items')
    expect(dayItems?.classList.contains('cal-capped')).toBe(false)
  })

  it('marks the week-row band container and calendar root for print CSS hooks', () => {
    const timeline = {
      name: 'Hook Trip', start_date: '2026-09-14', end_date: '2026-09-14',
      stops: [{ id: 1, location: 'Tokyo', arrive: '2026-09-14T10:00', depart: '2026-09-14T10:00', items: [] }],
    }
    const { container } = render(<TripCalendar timeline={timeline} view="week" anchorDay="2026-09-14" onOpenDay={() => {}} onOpenItem={() => {}} />)
    expect(container.querySelector('.cal-root')).toBeTruthy()
    expect(container.querySelector('.cal-week-row')).toBeTruthy()
    expect(container.querySelector('.cal-grid')).toBeTruthy()
  })
})
