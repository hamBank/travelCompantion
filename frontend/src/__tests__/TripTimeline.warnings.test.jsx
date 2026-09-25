import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * The "date/coverage warnings" banner in TripTimeline.jsx, and its two
 * one-click fix buttons: a plain "Fix → UTC±N" for a Timezone-mismatch-style
 * warning (suggested_timezone only), and a combined "Fix → Country, UTC±N"
 * for a Missing-country-style warning (suggested_country + suggested_timezone
 * together — see backend/validation.py:_missing_country_warnings), which
 * must PATCH both fields in one call so a one-click accept never leaves the
 * stop with one fixed and the other still wrong.
 */

const { getTripTimeline, getDateWarnings, getPending, updateStop } = vi.hoisted(() => ({
  getTripTimeline: vi.fn(),
  getDateWarnings: vi.fn(),
  getPending: vi.fn().mockResolvedValue([]),
  updateStop: vi.fn().mockResolvedValue({}),
}))

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getTripTimeline, getDateWarnings, getPending, updateStop,
  }
})

vi.mock('../online.js', () => ({ useOnline: () => true }))

vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), flush: vi.fn().mockResolvedValue({ synced: 0, conflicted: 0, authExpired: false }) },
  sendOp: vi.fn(),
}))

import TripTimeline from '../components/TripTimeline.jsx'
import { NavBaseContext } from '../navContext.js'

const BASE = { v: 1, tripId: 1, mode: 'timeline', day: null, calView: null, planning: false, overlay: null, item: null }

function timelineFixture() {
  return {
    id: 1, start_date: '2026-08-01', end_date: '2026-08-10', role: 'owner',
    stops: [{
      id: 100, location: 'Rome', country: '', status: 'planned',
      arrive: '2026-08-04T00:00', depart: '2026-08-06T00:00',
      items: [{ id: 1, kind: 'activity', name: 'Colosseum', status: 'pending', scheduled_at: '2026-08-04T10:00', details: {} }],
    }],
  }
}

function renderTimeline() {
  return render(
    <NavBaseContext.Provider value={BASE}>
      <TripTimeline tripId={1} todayMode={false} />
    </NavBaseContext.Provider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getTripTimeline.mockResolvedValue(timelineFixture())
  getPending.mockResolvedValue([])
  window.history.replaceState(null, '', '/')
})

describe('Timezone mismatch warning (timezone-only fix)', () => {
  it('shows a plain UTC fix button, and clicking it PATCHes only the timezone', async () => {
    getDateWarnings.mockResolvedValue({
      warnings: [{
        item_id: null, name: 'Timezone mismatch', kind: null, stop_location: 'Rome',
        item_date: '2026-08-04', stop_arrive: '2026-08-04T00:00', stop_depart: '2026-08-06T00:00',
        reason: 'Stop timezone 5 doesn\'t match Rome\'s real offset UTC+2 (Europe/Rome)',
        stop_id: 100, suggested_timezone: '2',
      }],
    })
    renderTimeline()
    await screen.findByText('Colosseum')

    const fixBtn = await screen.findByText('Fix → UTC+2')
    fireEvent.click(fixBtn)

    await waitFor(() => expect(updateStop).toHaveBeenCalledWith(100, { timezone: '2' }))
    // Timezone-only fix never touches country.
    expect(updateStop.mock.calls[0][1]).not.toHaveProperty('country')
  })
})

describe('Missing country warning (combined country+timezone fix)', () => {
  it('shows a combined fix button, and clicking it PATCHes both country and timezone together', async () => {
    getDateWarnings.mockResolvedValue({
      warnings: [{
        item_id: null, name: 'Missing country', kind: null, stop_location: 'Rome',
        item_date: '2026-08-04', stop_arrive: '2026-08-04T00:00', stop_depart: '2026-08-06T00:00',
        reason: 'No country set — Rome is in Italy (UTC+2 on arrival, Europe/Rome)',
        stop_id: 100, suggested_country: 'Italy', suggested_timezone: '2',
      }],
    })
    renderTimeline()
    await screen.findByText('Colosseum')

    const fixBtn = await screen.findByText('Fix → Italy, UTC+2')
    fireEvent.click(fixBtn)

    await waitFor(() => expect(updateStop).toHaveBeenCalledWith(100, { country: 'Italy', timezone: '2' }))
  })

  it('disables the button and shows "Fixing…" while the PATCH is in flight', async () => {
    let resolvePatch
    updateStop.mockReturnValue(new Promise(r => { resolvePatch = r }))
    getDateWarnings.mockResolvedValue({
      warnings: [{
        item_id: null, name: 'Missing country', kind: null, stop_location: 'Rome',
        item_date: '2026-08-04', stop_arrive: '2026-08-04T00:00', stop_depart: '2026-08-06T00:00',
        reason: 'No country set — Rome is in Italy (UTC+2 on arrival, Europe/Rome)',
        stop_id: 100, suggested_country: 'Italy', suggested_timezone: '2',
      }],
    })
    renderTimeline()
    await screen.findByText('Colosseum')

    fireEvent.click(await screen.findByText('Fix → Italy, UTC+2'))
    const fixingBtn = await screen.findByText('Fixing…')
    expect(fixingBtn).toBeDisabled()

    resolvePatch({})
    await waitFor(() => expect(screen.queryByText('Fixing…')).toBeNull())
  })
})
