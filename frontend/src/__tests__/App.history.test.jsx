import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { forwardRef, useEffect } from 'react'

/**
 * Plan-18a: browser Back/Forward for the App shell (historyNav.js + App.jsx
 * wiring). historyNav.js's own push/replace/guard/layerDepth mechanics are
 * covered in isolation by historyNav.test.js — this file covers App.jsx's
 * side: that the right action sites push vs. replace vs. call back(), and
 * that a popped snapshot is applied correctly (applyNav), including the
 * planning-draft guard on Back.
 *
 * pushNav/replaceNav/back are spied *and* forwarded to the real
 * implementation (see the historyNav.js mock below) — real history state
 * changes and real popstate/guard delivery keep working exactly as in
 * production, while still letting tests assert on the calls App.jsx made.
 */

const { getTrip, getTripTimeline, getPending } = vi.hoisted(() => ({
  getTrip: vi.fn(),
  getTripTimeline: vi.fn(),
  getPending: vi.fn().mockResolvedValue([]),
}))

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAuthConfig: vi.fn().mockResolvedValue({ enabled: false, client_id: '' }),
    getTrips: vi.fn(),
    getPending,
    exportTripPdf: vi.fn(),
    refreshAuthToken: vi.fn().mockResolvedValue({}),
    getTripTimeline,
    getTrip,
  }
})

vi.mock('../online.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useOnline: vi.fn(() => true) }
})

vi.mock('../historyNav.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    pushNav: vi.fn(actual.pushNav),
    replaceNav: vi.fn(actual.replaceNav),
    back: vi.fn(actual.back),
  }
})

// forwardRef — App.jsx passes a ref for plan-18b's seam. Reports one dummy
// stop via onStops so the "+ Add item" (quickAdd) footer button renders,
// and renders an "Import from document" close button while `importing` is
// true, mirroring what the real TripTimeline/DocumentImportModal do closely
// enough to exercise App's overlay wiring around it.
const { TripTimelineMock } = vi.hoisted(() => ({ TripTimelineMock: vi.fn() }))
vi.mock('../components/TripTimeline.jsx', () => ({
  default: forwardRef((props, ref) => TripTimelineMock(props, ref)),
}))

vi.mock('../components/TripCalendar.jsx', () => ({
  default: vi.fn(({ view, planning, draft, onDraftChange, onOpenDay }) => (
    <div data-testid="calendar" data-view={view} data-planning={String(planning)}>
      {planning && (
        <button onClick={() => onDraftChange({
          ...draft,
          moves: { ...draft.moves, 1: { arrive: '2026-10-04T00:00', depart: '2026-10-07T00:00' } },
        })}>
          simulate-drag
        </button>
      )}
      <button onClick={() => onOpenDay('2026-09-16')}>open-day</button>
    </div>
  )),
}))

// Minimal stand-ins for every overlay App.jsx mounts — real behaviour is
// each component's own test file; here only onClose (-> back()) and the
// open-time push matter.
vi.mock('../components/UserSettings.jsx', () => ({
  default: ({ onClose }) => <div data-testid="overlay-settings"><button onClick={onClose}>close-settings</button></div>,
}))
vi.mock('../components/DocumentsModal.jsx', () => ({
  default: ({ onClose }) => <div data-testid="overlay-documents"><button onClick={onClose}>close-documents</button></div>,
}))
vi.mock('../components/ShareModal.jsx', () => ({
  default: ({ onClose }) => <div data-testid="overlay-share"><button onClick={onClose}>close-share</button></div>,
}))
vi.mock('../components/TravelersModal.jsx', () => ({
  default: ({ onClose }) => <div data-testid="overlay-travelers"><button onClick={onClose}>close-travelers</button></div>,
}))
vi.mock('../components/BudgetSummary.jsx', () => ({
  default: ({ onClose }) => <div data-testid="overlay-budget"><button onClick={onClose}>close-budget</button></div>,
}))
vi.mock('../components/DistanceSummary.jsx', () => ({
  default: ({ onClose }) => <div data-testid="overlay-distance"><button onClick={onClose}>close-distance</button></div>,
}))
vi.mock('../components/PendingReview.jsx', () => ({
  default: ({ onClose }) => <div data-testid="overlay-imports"><button onClick={onClose}>close-imports</button></div>,
}))
vi.mock('../components/ItemEditModal.jsx', () => ({
  default: ({ onClose, onSave }) => (
    <div data-testid="overlay-quickadd">
      <button onClick={() => onSave({})}>save-quickadd</button>
      <button onClick={onClose}>close-quickadd</button>
    </div>
  ),
}))

vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import { getTrips } from '../api.js'
import { pushNav, replaceNav, back as backSpy, rootSnapshot } from '../historyNav.js'
import { clearNav } from '../navState.js'
import App, { snapshotFromState, OVERLAY_KINDS } from '../App.jsx'

function trip(id = 1, overrides = {}) {
  return { id, name: `Trip ${id}`, start_date: '2026-09-14', end_date: '2026-09-20', role: 'owner', ...overrides }
}

function popTo(overrides) {
  window.dispatchEvent(new PopStateEvent('popstate', {
    state: { v: 1, tripId: null, mode: 'timeline', day: null, calView: null, planning: false, overlay: null, item: null, ...overrides },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearNav()
  window.history.replaceState(null, '') // start every test on a clean, foreign entry
  getPending.mockResolvedValue([])
  getTripTimeline.mockResolvedValue({ id: 1, start_date: '2026-09-14', end_date: '2026-09-20', stops: [] })
  TripTimelineMock.mockImplementation(({ onStops, importing, setImporting }) => {
    useEffect(() => { onStops?.([{ id: 1 }]) }, [])
    return (
      <div data-testid="timeline">
        {importing && <button onClick={() => setImporting(false)}>close-importdoc</button>}
      </div>
    )
  })
})

afterEach(() => { clearNav() })

async function openTrip1() {
  getTrips.mockResolvedValue([trip(1)])
  render(<App />)
  await waitFor(() => expect(screen.getByText('Trip 1')).toBeTruthy())
}

describe('boot and opening a trip', () => {
  it('boot replaces the root snapshot; opening a trip pushes {tripId, mode: timeline}', async () => {
    await openTrip1()
    expect(replaceNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: null, mode: 'timeline' }))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1, mode: 'timeline' }))
  })
})

describe('header back button', () => {
  it('calls back() without itself changing state; the resulting popstate shows the list', async () => {
    await openTrip1()

    fireEvent.click(screen.getByLabelText('Back to trip list'))
    expect(backSpy).toHaveBeenCalled()
    // back() is async (real history navigation) — nothing else in the
    // click handler touches state, so the trip is still on screen right
    // after the click (D4: the affordance never sets state directly).
    expect(screen.getByText('Trip 1')).toBeTruthy()

    popTo(rootSnapshot())
    await waitFor(() => expect(screen.queryByText('Trip 1')).toBeNull())
    expect(screen.getByText(/Travel Companion/)).toBeTruthy()
  })
})

describe('mode toggles push; Timeline (from within a mode) closes via back(); calendar view replaces', () => {
  it('Packing: enter pushes, "Timeline" closes via back()', async () => {
    await openTrip1()
    pushNav.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('Packing'))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1, mode: 'packing' }))

    backSpy.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('Timeline'))
    expect(backSpy).toHaveBeenCalled()
  })

  it('Edit: enter pushes, "View" closes via back()', async () => {
    await openTrip1()
    pushNav.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('Edit'))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1, mode: 'edit' }))

    backSpy.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('View'))
    expect(backSpy).toHaveBeenCalled()
  })

  it('Calendar: enter pushes; changing the view replaces (not push)', async () => {
    await openTrip1()
    pushNav.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('Calendar'))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1, mode: 'calendar' }))
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())

    pushNav.mockClear()
    replaceNav.mockClear()
    fireEvent.click(screen.getByText('Month'))
    expect(replaceNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1, mode: 'calendar', calView: 'month' }))
    expect(pushNav).not.toHaveBeenCalled()

    backSpy.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('Timeline'))
    expect(backSpy).toHaveBeenCalled()
  })

  it('Calendar onOpenDay hand-off: pushes a Today snapshot with the day (plan-18b)', async () => {
    await openTrip1()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('Calendar'))
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    pushNav.mockClear()

    fireEvent.click(screen.getByText('open-day'))

    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({
      tripId: 1, mode: 'today', day: '2026-09-16',
    }))
  })

  it('Today ("All days" footer toggle): enter pushes, closing calls back()', async () => {
    await openTrip1()
    pushNav.mockClear()
    fireEvent.click(screen.getByText('Today'))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1, mode: 'today' }))

    backSpy.mockClear()
    fireEvent.click(screen.getByText('All days'))
    expect(backSpy).toHaveBeenCalled()
  })
})

describe('overlays push on open; onClose calls back()', () => {
  const cases = [
    ['Settings', 'overlay-settings', 'close-settings', 'settings'],
    ['Documents', 'overlay-documents', 'close-documents', 'documents'],
    ['Share', 'overlay-share', 'close-share', 'share'],
    ['Travelers', 'overlay-travelers', 'close-travelers', 'travelers'],
    ['Budget', 'overlay-budget', 'close-budget', 'budget'],
    ['Distance', 'overlay-distance', 'close-distance', 'distance'],
  ]

  it.each(cases)('%s', async (menuText, testId, closeText, kind) => {
    await openTrip1()
    pushNav.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText(menuText))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ tripId: 1, overlay: { kind } }))
    await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy())

    backSpy.mockClear()
    fireEvent.click(screen.getByText(closeText))
    expect(backSpy).toHaveBeenCalled()
  })

  it('Imports (pending count > 0): pushes on open, onClose calls back()', async () => {
    getPending.mockResolvedValue([{ id: 1 }])
    await openTrip1()
    pushNav.mockClear()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(await screen.findByText(/Imports \(/))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ overlay: { kind: 'imports' } }))
    await waitFor(() => expect(screen.getByTestId('overlay-imports')).toBeTruthy())

    backSpy.mockClear()
    fireEvent.click(screen.getByText('close-imports'))
    expect(backSpy).toHaveBeenCalled()
  })

  it('quick-add (+ Add item): pushes on open; Save and Close both call back()', async () => {
    await openTrip1()
    await waitFor(() => expect(screen.getByText('+ Add item')).toBeTruthy())
    pushNav.mockClear()
    fireEvent.click(screen.getByText('+ Add item'))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ overlay: { kind: 'quickAdd' } }))
    await waitFor(() => expect(screen.getByTestId('overlay-quickadd')).toBeTruthy())

    backSpy.mockClear()
    fireEvent.click(screen.getByText('save-quickadd'))
    expect(backSpy).toHaveBeenCalled()
  })

  it('import-from-document: pushes on open; closing calls back()', async () => {
    await openTrip1()
    pushNav.mockClear()
    fireEvent.click(screen.getByText('⇪ Import from document'))
    expect(pushNav).toHaveBeenCalledWith(expect.objectContaining({ overlay: { kind: 'importDoc' } }))
    await waitFor(() => expect(screen.getByText('close-importdoc')).toBeTruthy())

    backSpy.mockClear()
    fireEvent.click(screen.getByText('close-importdoc'))
    expect(backSpy).toHaveBeenCalled()
  })
})

describe('applyNav resolving a trip not already held', () => {
  it('fetches getTrip and applies its role for a foreign trip id in a popped snapshot', async () => {
    getTrip.mockResolvedValue(trip(2, { name: 'Trip 2', role: 'viewer' }))
    await openTrip1()

    popTo({ tripId: 2, mode: 'timeline' })

    await waitFor(() => expect(getTrip).toHaveBeenCalledWith(2))
    await waitFor(() => expect(screen.getByText('Trip 2')).toBeTruthy())

    // Trip 2's role (viewer) came from getTrip, not stale from Trip 1
    // (owner) — a viewer can't Edit, so the menu item disappears.
    fireEvent.click(screen.getByLabelText('Menu'))
    expect(screen.queryByText('Edit')).toBeNull()
  })
})

describe('planning draft guard on Back', () => {
  it('confirms on Back; Cancel undoes the pop (draft intact); a fresh Back + OK applies it', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {})

    await openTrip1()
    fireEvent.click(screen.getByLabelText('Menu'))
    fireEvent.click(screen.getByText('Calendar'))
    await waitFor(() => expect(screen.getByTestId('calendar')).toBeTruthy())
    fireEvent.click(screen.getByText('Plan'))
    await waitFor(() => expect(screen.getByTestId('calendar').dataset.planning).toBe('true'))
    fireEvent.click(screen.getByText('simulate-drag'))
    expect(screen.getByText('1 change')).toBeTruthy()

    const calendarNoPlanning = { tripId: 1, mode: 'calendar' } // one layer back: planning closes, calendar stays

    confirmSpy.mockReturnValueOnce(false)
    popTo(calendarNoPlanning)
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(goSpy).toHaveBeenCalledWith(1)
    // Cancelled — draft and planning mode are untouched.
    expect(screen.getByText('1 change')).toBeTruthy()
    expect(screen.getByTestId('calendar').dataset.planning).toBe('true')

    // history.go(1) (mocked away above) would fire its own echo popstate in
    // a real browser — deliver it manually so historyNav's suppressNext
    // doesn't eat the *next* (real) Back attempt below.
    popTo(calendarNoPlanning)

    confirmSpy.mockReturnValueOnce(true)
    popTo(calendarNoPlanning)
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('calendar').dataset.planning).toBe('false'))
    // The draft was discarded along with planning mode.
    expect(screen.queryByText('simulate-drag')).toBeNull()
  })
})

describe('snapshotFromState knows every show* overlay flag', () => {
  const baseState = {
    selectedTrip: { id: 1 }, editing: false, packing: false, today: false, calendar: false,
    calendarView: 'trip', planning: false,
    showSettings: false, showShare: false, showBudget: false, showDistance: false,
    showDocuments: false, showTravelers: false, showImports: false, showQuickAdd: false, showImportDoc: false,
  }

  it('every OVERLAY_KINDS flag, set alone, produces the matching overlay.kind', () => {
    for (const [flag, kind] of Object.entries(OVERLAY_KINDS)) {
      const snapshot = snapshotFromState({ ...baseState, [flag]: true })
      expect(snapshot.overlay).toEqual({ kind })
    }
  })

  it('no flag set means overlay is null', () => {
    expect(snapshotFromState(baseState).overlay).toBeNull()
  })
})
