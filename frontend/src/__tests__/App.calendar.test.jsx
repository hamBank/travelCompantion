import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * Calendar menu toggle + footer view switcher (plan-16b) wiring in App.jsx:
 * the hamburger's Calendar/Timeline item swaps the main view and the footer
 * segmented control; tapping "Day" (or a chip, via TripCalendar's onOpenDay/
 * onOpenItem) exits back into Today mode on the chosen day, honouring
 * TripTimeline's new `initialDay` prop rather than its own pickInitialDay.
 */

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAuthConfig: vi.fn().mockResolvedValue({ enabled: false, client_id: '' }),
    getTrips: vi.fn(),
    getPending: vi.fn().mockResolvedValue([]),
    exportTripPdf: vi.fn(),
    refreshAuthToken: vi.fn().mockResolvedValue({}),
    getTripTimeline: vi.fn().mockResolvedValue({ id: 1, start_date: '2026-09-14', end_date: '2026-09-20', stops: [] }),
  }
})

vi.mock('../components/TripTimeline.jsx', () => ({
  default: vi.fn(({ todayMode, initialDay }) => (
    <div data-testid="timeline" data-today={String(todayMode)} data-initial-day={initialDay ?? ''} />
  )),
}))

vi.mock('../components/TripCalendar.jsx', () => ({
  default: vi.fn(({ view, onOpenDay, onOpenItem }) => (
    <div data-testid="calendar" data-view={view}>
      <button onClick={() => onOpenDay('2026-09-16')}>open-day</button>
      <button onClick={() => onOpenItem({ id: 5, kind: 'activity', name: 'Museum', scheduled_at: '2026-09-17T09:00', details: {} })}>open-item</button>
    </div>
  )),
}))

// Unrelated to what's under test — OfflineQueueBanner reads IndexedDB on
// mount via offlineQueue.js, which jsdom doesn't provide.
vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import { getTrips } from '../api.js'
import TripTimeline from '../components/TripTimeline.jsx'
import TripCalendar from '../components/TripCalendar.jsx'
import { clearNav } from '../navState.js'
import App from '../App.jsx'

const TRIP = { id: 1, name: 'Solo Trip', start_date: '2026-09-14', end_date: '2026-09-20', role: 'owner' }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNav()
  getTrips.mockResolvedValue([TRIP])
})

afterEach(() => { clearNav() })

async function openTripAndCalendar() {
  render(<App />)
  fireEvent.click(await screen.findByText('Solo Trip'))
  await waitFor(() => expect(TripTimeline).toHaveBeenCalled())
  const menuTrigger = screen.getByLabelText('Menu')
  fireEvent.click(menuTrigger)
  fireEvent.click(screen.getByText('Calendar'))
}

describe('Calendar menu toggle', () => {
  it('switches the main view to the calendar and shows the footer segmented control', async () => {
    await openTripAndCalendar()
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    expect(screen.queryByTestId('timeline')).toBeNull()
    expect(screen.getByText('Day')).toBeTruthy()
    expect(screen.getByText('Week')).toBeTruthy()
    expect(screen.getByText('Month')).toBeTruthy()
    expect(screen.getByText('Trip')).toBeTruthy()
  })

  it('the menu item toggles back to Timeline label once calendar is open', async () => {
    await openTripAndCalendar()
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Menu'))
    expect(screen.getByText('Timeline')).toBeTruthy()
  })

  it('Day → Today mode with the calendar\'s anchor day honoured as initialDay', async () => {
    await openTripAndCalendar()
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    fireEvent.click(screen.getByText('open-day'))
    await waitFor(() => {
      const last = TripTimeline.mock.calls.at(-1)[0]
      expect(last.todayMode).toBe(true)
      expect(last.initialDay).toBe('2026-09-16')
    })
    expect(screen.queryByTestId('calendar')).toBeNull()
  })

  it('a chip tap (onOpenItem) opens Today mode on the item\'s own placement day', async () => {
    await openTripAndCalendar()
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    fireEvent.click(screen.getByText('open-item'))
    await waitFor(() => {
      const last = TripTimeline.mock.calls.at(-1)[0]
      expect(last.todayMode).toBe(true)
      expect(last.initialDay).toBe('2026-09-17') // the mocked item's scheduled_at day
    })
  })
})

/**
 * Print button (plan-16c): footer seam in calendar mode, landscape class
 * toggled on <html> for Week/Trip (not Month) around window.print(), and
 * removed again on `afterprint` (fired whether the dialog was completed or
 * cancelled — the only reliable cleanup hook, see App.jsx's handlePrintCalendar).
 */
describe('Calendar Print button', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('print-landscape')
  })

  it('calls window.print and does not leave the landscape class on afterward', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    await openTripAndCalendar()
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Print calendar'))
    expect(printSpy).toHaveBeenCalledTimes(1)
    // Default calendarView on first open is 'trip' (getCalendarView's
    // default) — a landscape view — so the class goes on before print()...
    expect(document.documentElement.classList.contains('print-landscape')).toBe(true)
    fireEvent(window, new Event('afterprint'))
    // ...and comes back off afterward, leaving the on-screen view unchanged.
    expect(document.documentElement.classList.contains('print-landscape')).toBe(false)
    printSpy.mockRestore()
  })

  it('does not add the landscape class for Month view', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    await openTripAndCalendar()
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    fireEvent.click(screen.getByText('Month'))
    fireEvent.click(screen.getByLabelText('Print calendar'))
    expect(printSpy).toHaveBeenCalledTimes(1)
    expect(document.documentElement.classList.contains('print-landscape')).toBe(false)
    printSpy.mockRestore()
  })

  it('adds the landscape class for Trip view', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    await openTripAndCalendar()
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    fireEvent.click(screen.getByText('Trip'))
    fireEvent.click(screen.getByLabelText('Print calendar'))
    expect(document.documentElement.classList.contains('print-landscape')).toBe(true)
    printSpy.mockRestore()
    document.documentElement.classList.remove('print-landscape')
  })
})
