import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ITEM_DATETIME_KEYS, applyDraft, draftToRequest, emptyDraft, draftChangeCount,
  cellFromPoint, dayKeyAt, stopDeltaDays, shiftDateStr,
} from '../calendarModel.js'

// plan-16d: planning-mode draft logic (applyDraft/draftToRequest) and D8's
// pure grid-geometry hit testing (cellFromPoint/dayKeyAt). See
// docs/plans/plan-16d-planning-mode.md's "Tests" section.

describe('shiftDateStr (shape-preserving, mirrors backend/reschedule.py::shift_datetime_str)', () => {
  it('date-only stays date-only', () => {
    expect(shiftDateStr('2026-08-10', 4)).toBe('2026-08-14')
  })
  it('keeps time-of-day and drops/keeps seconds exactly as given', () => {
    expect(shiftDateStr('2026-08-10T10:30', 4)).toBe('2026-08-14T10:30')
    expect(shiftDateStr('2026-08-10T10:30:15', 1)).toBe('2026-08-11T10:30:15')
  })
  it('month/year rollover', () => {
    expect(shiftDateStr('2026-12-30T23:00', 4)).toBe('2027-01-03T23:00')
  })
  it('unparseable input is returned unchanged', () => {
    expect(shiftDateStr('not a date', 4)).toBe('not a date')
    expect(shiftDateStr('', 4)).toBe('')
    expect(shiftDateStr(null, 4)).toBe(null)
  })
})

describe('stopDeltaDays', () => {
  it('arrive-based', () => {
    expect(stopDeltaDays('2026-09-30T00:00', '2026-10-03T00:00', '2026-10-04T00:00', '2026-10-07T00:00')).toBe(4)
  })
  it('falls back to depart when there is no arrive', () => {
    expect(stopDeltaDays(null, '2026-09-30T00:00', null, '2026-10-04T00:00')).toBe(4)
  })
  it('is 0 when the OLD stop was undated', () => {
    expect(stopDeltaDays(null, null, '2026-10-04T00:00', '2026-10-07T00:00')).toBe(0)
  })
})

function item(overrides) {
  return { id: 1, kind: 'activity', name: 'Item', status: 'pending', scheduled_at: null, details: {}, ...overrides }
}

describe('applyDraft', () => {
  it('moving a stop +4 days shifts the stop and every item date key +4, time-of-day preserved, untouched keys absent', () => {
    const flight = item({ id: 10, kind: 'flight', details: { depart_time: '2026-09-30T09:00', arrive_time: '2026-09-30T11:00' } })
    const accommodation = item({ id: 11, kind: 'accommodation', details: { checkin: '2026-09-30T15:00', checkout: '2026-10-03T10:00', bag_drop: '2026-09-30T13:00' } })
    const activity = item({ id: 12, kind: 'activity', scheduled_at: '2026-10-01T09:00:00' })
    const undated = item({ id: 13, kind: 'note' })
    const timeline = {
      stops: [{ id: 1, location: 'Kyoto', arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00', items: [flight, accommodation, activity, undated] }],
    }
    const draft = { ...emptyDraft(), moves: { 1: { arrive: '2026-10-04T00:00', depart: '2026-10-07T00:00' } } }
    const result = applyDraft(timeline, draft)

    const stop = result.stops[0]
    expect(stop.arrive).toBe('2026-10-04T00:00')
    expect(stop.depart).toBe('2026-10-07T00:00')

    const shifted = Object.fromEntries(stop.items.map(i => [i.id, i]))
    expect(shifted[10].details.depart_time).toBe('2026-10-04T09:00')
    expect(shifted[10].details.arrive_time).toBe('2026-10-04T11:00')
    expect(shifted[11].details.checkin).toBe('2026-10-04T15:00')
    expect(shifted[11].details.checkout).toBe('2026-10-07T10:00')
    expect(shifted[11].details.bag_drop).toBe('2026-10-04T13:00')
    expect(shifted[12].scheduled_at).toBe('2026-10-05T09:00:00')
    // Untouched keys are absent, not present-as-undefined.
    expect('pickup_time' in shifted[10].details).toBe(false)
    // An undated item is untouched.
    expect(shifted[13].scheduled_at).toBeNull()

    // Pure: the original timeline (and its stops/items) are not mutated.
    expect(timeline.stops[0].arrive).toBe('2026-09-30T00:00')
    expect(flight.details.depart_time).toBe('2026-09-30T09:00')
  })

  it('resize only (arrive unchanged) leaves items untouched', () => {
    const activity = item({ id: 12, kind: 'activity', scheduled_at: '2026-10-01T09:00:00' })
    const timeline = { stops: [{ id: 1, location: 'Kyoto', arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00', items: [activity] }] }
    const draft = { ...emptyDraft(), moves: { 1: { arrive: '2026-09-30T00:00', depart: '2026-10-05T00:00' } } }
    const result = applyDraft(timeline, draft)
    expect(result.stops[0].depart).toBe('2026-10-05T00:00')
    expect(result.stops[0].items[0].scheduled_at).toBe('2026-10-01T09:00:00')
  })

  it('moving a previously-undated stop is a delta-0 no-op for its items', () => {
    const activity = item({ id: 12, kind: 'activity', scheduled_at: '2026-10-01T09:00:00' })
    const timeline = { stops: [{ id: 1, location: 'TBD', arrive: null, depart: null, items: [activity] }] }
    const draft = { ...emptyDraft(), moves: { 1: { arrive: '2026-10-04T00:00', depart: '2026-10-07T00:00' } } }
    const result = applyDraft(timeline, draft)
    expect(result.stops[0].items[0].scheduled_at).toBe('2026-10-01T09:00:00')
  })

  it('a temp create appears as a stop with no items', () => {
    const timeline = { stops: [] }
    const draft = { ...emptyDraft(), creates: { 'tmp-1': { location: 'Hakone', country: 'JP', arrive: '2026-10-05T00:00', depart: '2026-10-06T00:00', timezone: 'GMT+9' } } }
    const result = applyDraft(timeline, draft)
    expect(result.stops).toHaveLength(1)
    expect(result.stops[0]).toMatchObject({ id: 'tmp-1', location: 'Hakone', arrive: '2026-10-05T00:00', items: [] })
  })

  it('a deleted stop disappears from the result', () => {
    const timeline = { stops: [{ id: 1, location: 'Kyoto', arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00', items: [] }] }
    const draft = { ...emptyDraft(), deletes: [1] }
    const result = applyDraft(timeline, draft)
    expect(result.stops).toEqual([])
  })
})

describe('draftToRequest', () => {
  const originalStops = [
    { id: 1, arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00' },
    { id: 2, arrive: '2026-10-10T00:00', depart: '2026-10-12T00:00' },
  ]

  it('omits stops whose draft dates match the original (no-op moves)', () => {
    const draft = { ...emptyDraft(), moves: { 1: { arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00' } } }
    const req = draftToRequest(draft, originalStops)
    expect(req.moves).toEqual([])
  })

  it('includes changed moves with base set to the original values', () => {
    const draft = { ...emptyDraft(), moves: { 1: { arrive: '2026-10-04T00:00', depart: '2026-10-07T00:00' } } }
    const req = draftToRequest(draft, originalStops)
    expect(req.moves).toEqual([{
      stop_id: 1, arrive: '2026-10-04T00:00', depart: '2026-10-07T00:00',
      base: { arrive: '2026-09-30T00:00', depart: '2026-10-03T00:00' },
    }])
  })

  it('temp ids become client_ref on creates', () => {
    const draft = { ...emptyDraft(), creates: { 'tmp-1': { location: 'Hakone', country: 'JP', arrive: '2026-10-05T00:00', depart: '2026-10-06T00:00', timezone: 'GMT+9' } } }
    const req = draftToRequest(draft, originalStops)
    expect(req.creates).toEqual([{ location: 'Hakone', country: 'JP', arrive: '2026-10-05T00:00', depart: '2026-10-06T00:00', timezone: 'GMT+9', client_ref: 'tmp-1' }])
  })

  it('passes deletes through', () => {
    const draft = { ...emptyDraft(), deletes: [2] }
    expect(draftToRequest(draft, originalStops).deletes).toEqual([2])
  })
})

describe('draftChangeCount', () => {
  it('sums moves + creates + deletes', () => {
    const draft = { moves: { 1: {}, 2: {} }, creates: { 'tmp-1': {} }, deletes: [3] }
    expect(draftChangeCount(draft)).toBe(4)
  })
  it('is 0 for an empty draft', () => {
    expect(draftChangeCount(emptyDraft())).toBe(0)
  })
})

describe('cellFromPoint', () => {
  const gridRect = { left: 100, top: 200, width: 700 } // 7 cols of 100px each

  it('maps a point to its column/row', () => {
    expect(cellFromPoint(gridRect, 7, 50, 150, 225)).toEqual({ col: 0, row: 0 })
    expect(cellFromPoint(gridRect, 7, 50, 250, 225)).toEqual({ col: 1, row: 0 })
    expect(cellFromPoint(gridRect, 7, 50, 250, 280)).toEqual({ col: 1, row: 1 })
  })

  it('a point exactly on a column edge belongs to the right-hand column', () => {
    // Column edges are at left+100, left+200, ... — exactly on one lands in
    // the column to its right (floor division).
    expect(cellFromPoint(gridRect, 7, 50, 200, 225)).toEqual({ col: 1, row: 0 })
  })

  it('clamps out-of-grid points into range', () => {
    expect(cellFromPoint(gridRect, 7, 50, -500, -500).col).toBe(0)
    expect(cellFromPoint(gridRect, 7, 50, -500, -500).row).toBe(0)
    expect(cellFromPoint(gridRect, 7, 50, 5000, 225).col).toBe(6)
  })
})

describe('dayKeyAt', () => {
  const weeks = [
    ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'],
    ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'],
  ]
  it('resolves a {col,row} to its day key', () => {
    expect(dayKeyAt(weeks, { col: 2, row: 0 })).toBe('2026-09-16')
    expect(dayKeyAt(weeks, { col: 2, row: 1 })).toBe('2026-09-23')
  })
  it('clamps an out-of-range row/col to the nearest real cell', () => {
    expect(dayKeyAt(weeks, { col: 0, row: 99 })).toBe('2026-09-21')
    expect(dayKeyAt(weeks, { col: 99, row: 0 })).toBe('2026-09-20')
  })
  it('returns null for an empty weeks list', () => {
    expect(dayKeyAt([], { col: 0, row: 0 })).toBeNull()
  })
})

// The frontend twin of tests/test_reschedule.py's
// test_item_datetime_keys_matches_frontend_edit_modal — both lists must stay
// pinned to the same source of truth so a ninth datetime key can't silently
// go unshifted on one side only.
describe('ITEM_DATETIME_KEYS', () => {
  it('matches the datetime-local fields actually rendered by ItemEditModal.jsx', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/components/ItemEditModal.jsx'), 'utf-8')
    const frontendKeys = new Set([...src.matchAll(/datetime-local" value=\{d\('(\w+)'\)/g)].map(m => m[1]))
    expect(src).toMatch(/core\.scheduled_at/)
    expect(new Set(ITEM_DATETIME_KEYS)).toEqual(frontendKeys)
  })
})
