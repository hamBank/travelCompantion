import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { createRef } from 'react'

/**
 * Plan-18b: history layers inside TripTimeline (day, item detail, detail ->
 * edit). historyNav.js's own push/replace/guard mechanics are covered in
 * isolation by historyNav.test.js and App.history.test.jsx covers the App
 * shell's own layers — this file covers TripTimeline's internal ones: that
 * the right action sites (card tap, j/k, day nav, Edit) push vs. replace,
 * and that a popped snapshot (applyNav, called directly via the ref — this
 * file renders TripTimeline standalone, not through App.jsx) is applied
 * correctly, including the "not loaded yet" stash and the dirty-edit guard.
 *
 * pushNav/replaceNav/back are spied *and* forwarded to the real
 * implementation (mirrors App.history.test.jsx) so real history state
 * changes and real popstate/guard delivery keep working exactly as in
 * production, while still letting tests assert on the calls TripTimeline made.
 */

const {
  getTripTimeline, backfillAccommodations, getDateWarnings, getPending,
  updateItemStatus, updateStop, deleteItem, getItemStops,
} = vi.hoisted(() => ({
  getTripTimeline: vi.fn(),
  backfillAccommodations: vi.fn().mockResolvedValue({}),
  getDateWarnings: vi.fn().mockResolvedValue({ warnings: [] }),
  getPending: vi.fn().mockResolvedValue([]),
  updateItemStatus: vi.fn(),
  updateStop: vi.fn(),
  deleteItem: vi.fn().mockResolvedValue({}),
  getItemStops: vi.fn().mockResolvedValue([]),
}))

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getTripTimeline, backfillAccommodations, getDateWarnings, getPending,
    updateItemStatus, updateStop, deleteItem, getItemStops,
  }
})

vi.mock('../online.js', () => ({ useOnline: () => true }))

// jsdom has no IndexedDB — offlineQueue.flush() (called by every load()) must
// resolve cleanly rather than reject and turn every render into an error page.
vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), flush: vi.fn().mockResolvedValue({ synced: 0, conflicted: 0, authExpired: false }) },
  sendOp: vi.fn(),
}))

vi.mock('../historyNav.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    pushNav: vi.fn(actual.pushNav),
    replaceNav: vi.fn(actual.replaceNav),
    back: vi.fn(actual.back),
  }
})

import TripTimeline from '../components/TripTimeline.jsx'
import { NavBaseContext } from '../navContext.js'
import { pushNav, replaceNav, back as backSpy } from '../historyNav.js'

const BASE = { v: 1, tripId: 1, mode: 'timeline', day: null, calView: null, planning: false, overlay: null, item: null }
const BASE_TODAY = { ...BASE, mode: 'today' }

function timelineFixture() {
  return {
    id: 1, start_date: '2026-10-01', end_date: '2026-10-05', role: 'owner',
    stops: [{
      id: 100, location: 'Paris', country: 'France', status: 'planned',
      arrive: '2026-10-01T00:00', depart: '2026-10-05T00:00',
      items: [
        { id: 1, kind: 'activity', name: 'Louvre', status: 'pending', scheduled_at: '2026-10-01T10:00', details: {} },
        { id: 2, kind: 'activity', name: 'Eiffel Tower', status: 'pending', scheduled_at: '2026-10-02T10:00', details: {} },
        { id: 3, kind: 'activity', name: 'Versailles', status: 'pending', scheduled_at: '2026-10-03T10:00', details: {} },
      ],
    }],
  }
}

function renderTimeline(props = {}, navBase = BASE) {
  const ref = createRef()
  const utils = render(
    <NavBaseContext.Provider value={navBase}>
      <TripTimeline ref={ref} tripId={1} todayMode={false} {...props} />
    </NavBaseContext.Provider>
  )
  return { ...utils, ref }
}

beforeEach(() => {
  vi.clearAllMocks()
  getTripTimeline.mockResolvedValue(timelineFixture())
  window.history.replaceState(null, '') // start every test on a clean, foreign entry
})

describe('opening an item (card tap)', () => {
  it('pushes {item:{id, edit:false}} with the current day', async () => {
    renderTimeline({ todayMode: true, initialDay: '2026-10-01' }, BASE_TODAY)
    // Wait for the day-nav header (only rendered once activeDay/selectedDay
    // has actually settled) rather than just the card text, which can also
    // appear in an earlier, not-yet-day-filtered render.
    await screen.findByLabelText('Next day')
    pushNav.mockClear()

    fireEvent.click(screen.getByText('Louvre'))

    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({
      tripId: 1, day: '2026-10-01', item: { id: 1, edit: false },
    }))
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())
  })
})

describe('j/k between items with the modal open', () => {
  it('replaces the entry, never pushes a new one', async () => {
    renderTimeline()
    await screen.findByText('Louvre')
    fireEvent.click(screen.getByText('Louvre'))
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())
    pushNav.mockClear()
    replaceNav.mockClear()

    act(() => {
      window.dispatchEvent(new CustomEvent('modalNav', { detail: { itemId: 1, direction: 'next' } }))
    })

    expect(replaceNav).toHaveBeenCalledWith(expect.objectContaining({ item: { id: 2, edit: false } }))
    expect(pushNav).not.toHaveBeenCalled()
  })
})

describe('closing the detail modal', () => {
  it('✕ calls back() without itself closing the modal; applyNav(item:null) then closes it and scrolls the card into view', async () => {
    const { ref } = renderTimeline()
    await screen.findByText('Louvre')
    fireEvent.click(screen.getByText('Louvre'))
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())

    const scrollSpy = vi.fn()
    const card = document.querySelector('[data-item-id="1"]')
    card.scrollIntoView = scrollSpy

    fireEvent.click(screen.getByText('✕'))
    expect(backSpy).toHaveBeenCalled()
    // back() is async (real history navigation) — the click handler itself
    // never touches state (D4), so the modal is still open right after.
    expect(screen.getByText('Attachments')).toBeInTheDocument()

    act(() => { ref.current.applyNav({ ...BASE, item: null }) })

    await waitFor(() => expect(screen.queryByText('Attachments')).toBeNull())
    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' })))
  })
})

describe('Edit from detail', () => {
  it('pushes {item:{id, edit:true}}; onDeleted closes both layers with go(-2)', async () => {
    renderTimeline()
    await screen.findByText('Louvre')
    fireEvent.click(screen.getByText('Louvre'))
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())
    pushNav.mockClear()

    fireEvent.click(screen.getByText('Edit'))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ item: { id: 1, edit: true } }))
    await waitFor(() => expect(screen.getByDisplayValue('Louvre')).toBeInTheDocument())

    const goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('Delete')) // confirm
    await waitFor(() => expect(deleteItem).toHaveBeenCalledWith(1))
    expect(goSpy).toHaveBeenCalledWith(-2)
  })
})

describe('applyNav — item not loaded yet / unknown id', () => {
  it('stashes an id requested before data loads, applying it once load() resolves', async () => {
    let resolveFetch
    getTripTimeline.mockReturnValue(new Promise(res => { resolveFetch = res }))
    const { ref } = renderTimeline()

    act(() => { ref.current.applyNav({ ...BASE, item: { id: 2, edit: false } }) })
    expect(screen.queryByText('Attachments')).toBeNull()

    await act(async () => { resolveFetch(timelineFixture()) })
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())
    // "Eiffel Tower" appears twice once the modal is open: once on its own
    // card, once in the modal's own header.
    expect(screen.getAllByText('Eiffel Tower').length).toBeGreaterThanOrEqual(2)
  })

  it('replaces the entry without item when the id is unknown', async () => {
    const { ref } = renderTimeline()
    await screen.findByText('Louvre')
    replaceNav.mockClear()

    act(() => { ref.current.applyNav({ ...BASE, item: { id: 999, edit: false } }) })

    await waitFor(() => expect(replaceNav).toHaveBeenCalledWith(expect.objectContaining({ item: null })))
    expect(screen.queryByText('Attachments')).toBeNull()
  })
})

describe('Today mode day navigation', () => {
  it('changing day replaces the entry with the new day', async () => {
    renderTimeline({ todayMode: true, initialDay: '2026-10-01' }, BASE_TODAY)
    await screen.findByLabelText('Next day')
    replaceNav.mockClear()

    fireEvent.click(screen.getByLabelText('Next day'))

    await waitFor(() => expect(replaceNav).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-10-02' })))
    await screen.findByText('Eiffel Tower')
  })

  it('entering Today mode replaces the entry to record the picked initial day', async () => {
    renderTimeline({ todayMode: true, initialDay: '2026-10-01' }, BASE_TODAY)
    await screen.findByText('Louvre')

    expect(replaceNav).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-10-01' }))
  })
})

describe('dirty-edit Back guard', () => {
  it('confirms before discarding; Cancel steps forward again and leaves the form intact', async () => {
    renderTimeline()
    await screen.findByText('Louvre')
    fireEvent.click(screen.getByText('Louvre'))
    await waitFor(() => expect(screen.getByText('Attachments')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Edit'))
    const nameInput = await screen.findByDisplayValue('Louvre')
    fireEvent.change(nameInput, { target: { value: 'Louvre (updated)' } })

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    const goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {})

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { ...BASE, item: { id: 1, edit: false } } }))
    })

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes?'))
    expect(goSpy).toHaveBeenCalledWith(1)
    // Cancelled — the edit form (with the typed change) is still open.
    expect(screen.getByDisplayValue('Louvre (updated)')).toBeInTheDocument()
  })
})
