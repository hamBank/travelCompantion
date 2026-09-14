import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { forwardRef } from 'react'

/**
 * Planning mode wiring in App.jsx (plan-16d): the Plan/Save/Discard footer
 * controls, the Save -> POST /trips/{id}/reschedule -> refetch -> date-
 * warnings -> Undo-toast flow, and the 409-keeps-the-draft path. TripCalendar
 * itself (the pointer/drag machinery) is covered by
 * calendarModel.planning.test.js and PlanningOverlay.test.jsx — here it's
 * mocked down to a "simulate-drag" button that calls onDraftChange exactly
 * like a real drag's commit would, so this file can focus purely on the
 * App-level Save/Discard/Undo/conflict wiring.
 */

const TIMELINE = {
  id: 1, start_date: '2026-09-14', end_date: '2026-09-20',
  stops: [{ id: 1, location: 'Tokyo', country: 'Japan', arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00', items: [] }],
}

const { rescheduleTrip, getDateWarnings, getTripTimeline } = vi.hoisted(() => ({
  rescheduleTrip: vi.fn(),
  getDateWarnings: vi.fn(),
  getTripTimeline: vi.fn(),
}))

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAuthConfig: vi.fn().mockResolvedValue({ enabled: false, client_id: '' }),
    getTrips: vi.fn(),
    getPending: vi.fn().mockResolvedValue([]),
    exportTripPdf: vi.fn(),
    refreshAuthToken: vi.fn().mockResolvedValue({}),
    getTripTimeline,
    rescheduleTrip,
    getDateWarnings,
  }
})

vi.mock('../online.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useOnline: vi.fn(() => true) }
})

// forwardRef — App.jsx passes a ref to TripTimeline (plan-18a's seam for 18b).
vi.mock('../components/TripTimeline.jsx', () => ({
  default: forwardRef((props, ref) => <div data-testid="timeline" />),
}))

vi.mock('../components/TripCalendar.jsx', () => ({
  default: vi.fn(({ view, planning, draft, onDraftChange }) => (
    <div data-testid="calendar" data-view={view} data-planning={String(planning)}>
      {planning && (
        <button onClick={() => onDraftChange({
          ...draft,
          moves: { ...draft.moves, 1: { arrive: '2026-10-04T00:00', depart: '2026-10-07T00:00' } },
        })}>
          simulate-drag
        </button>
      )}
    </div>
  )),
}))

vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import { getTrips } from '../api.js'
import { useOnline } from '../online.js'
import { clearNav } from '../navState.js'
import App from '../App.jsx'

function trip(role = 'owner') {
  return { id: 1, name: 'Solo Trip', start_date: '2026-09-14', end_date: '2026-09-20', role }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNav()
  useOnline.mockReturnValue(true)
  getTripTimeline.mockResolvedValue(TIMELINE)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => { clearNav() })

async function openTripAndCalendar(role = 'owner') {
  getTrips.mockResolvedValue([trip(role)])
  render(<App />)
  fireEvent.click(await screen.findByText('Solo Trip'))
  const menuTrigger = screen.getByLabelText('Menu')
  fireEvent.click(menuTrigger)
  fireEvent.click(screen.getByText('Calendar'))
  await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
}

describe('Plan button visibility', () => {
  it('hidden for a viewer', async () => {
    await openTripAndCalendar('viewer')
    expect(screen.queryByText('Plan')).toBeNull()
  })

  it('hidden while offline', async () => {
    useOnline.mockReturnValue(false)
    await openTripAndCalendar('owner')
    expect(screen.queryByText('Plan')).toBeNull()
  })

  it('shown for an editor while online', async () => {
    await openTripAndCalendar('owner')
    expect(screen.getByText('Plan')).toBeTruthy()
  })
})

describe('Save', () => {
  it('posts the draftToRequest body, refetches, shows date-warnings and an Undo toast', async () => {
    rescheduleTrip.mockResolvedValue({
      stops: [], created: [], shifted_items: [],
      inverse: { moves: [{ stop_id: 1, arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00' }], creates: [], deletes: [] },
      undo_lossy: false,
    })
    getDateWarnings.mockResolvedValue({ warnings: ['Hotel checkout is before the stop\'s departure'] })

    await openTripAndCalendar('owner')
    fireEvent.click(screen.getByText('Plan'))
    expect(screen.getByTestId('calendar').dataset.planning).toBe('true')

    fireEvent.click(screen.getByText('simulate-drag'))
    expect(screen.getByText('1 change')).toBeTruthy()

    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(rescheduleTrip).toHaveBeenCalledWith(1, {
      moves: [{ stop_id: 1, arrive: '2026-10-04T00:00', depart: '2026-10-07T00:00', base: { arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00' } }],
      creates: [], deletes: [],
    }))

    // Exits planning and refetches the timeline.
    await waitFor(() => expect(screen.getByTestId('calendar').dataset.planning).toBe('false'))
    expect(getTripTimeline).toHaveBeenCalledTimes(2) // initial open + post-save refetch

    await waitFor(() => expect(screen.getByText(/Hotel checkout is before/)).toBeTruthy())
    const undoBtn = await screen.findByText('Undo')

    fireEvent.click(undoBtn)
    await waitFor(() => expect(rescheduleTrip).toHaveBeenCalledWith(1, {
      moves: [{ stop_id: 1, arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00' }], creates: [], deletes: [],
    }))
  })

  it('a 409 keeps the draft and shows the conflicting fields', async () => {
    const err = new Error('Conflict')
    err.status = 409
    err.detail = { conflicts: [{ field: 'arrive', mine: '2026-10-04T00:00', server: '2026-10-05T00:00' }], current: { id: 1, location: 'Tokyo' } }
    rescheduleTrip.mockRejectedValue(err)

    await openTripAndCalendar('owner')
    fireEvent.click(screen.getByText('Plan'))
    fireEvent.click(screen.getByText('simulate-drag'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(screen.getByText(/yours "2026-10-04T00:00" vs\. theirs "2026-10-05T00:00"/)).toBeTruthy())
    // The draft survives the 409 — still in planning mode with the change kept.
    expect(screen.getByTestId('calendar').dataset.planning).toBe('true')
    expect(screen.getByText('1 change')).toBeTruthy()
  })
})

describe('Discard', () => {
  it('clears the draft without making a request', async () => {
    await openTripAndCalendar('owner')
    fireEvent.click(screen.getByText('Plan'))
    fireEvent.click(screen.getByText('simulate-drag'))
    expect(screen.getByText('1 change')).toBeTruthy()

    fireEvent.click(screen.getByText('Discard'))

    expect(rescheduleTrip).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Plan')).toBeTruthy())
    expect(screen.getByTestId('calendar').dataset.planning).toBe('false')
  })
})
