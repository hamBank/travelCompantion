import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useContext } from 'react'
import { HideTimeCtx, itemTimeStr, itemDateKey, computeLayovers, computeCrossStopLayover, fmtConnectionDur, toUtcMs } from '../components/StopCard.jsx'

// ── itemTimeStr ──────────────────────────────────────────────────────────────

describe('itemTimeStr', () => {
  it('returns HH:MM AM/PM for flight departure time', () => {
    const item = { kind: 'flight', details: { depart_time: '2026-08-19T16:25' }, scheduled_at: null }
    expect(itemTimeStr(item)).toBe('4:25 PM')
  })

  it('returns HH:MM AM/PM for rail departure time', () => {
    const item = { kind: 'rail', details: { depart_time: '2026-08-20T08:05' }, scheduled_at: null }
    expect(itemTimeStr(item)).toBe('8:05 AM')
  })

  it('returns scheduled_at time for non-transport kinds', () => {
    const item = { kind: 'activity', details: {}, scheduled_at: '2026-08-21T14:30' }
    expect(itemTimeStr(item)).toBe('2:30 PM')
  })

  it('returns empty string when no time component', () => {
    const item = { kind: 'activity', details: {}, scheduled_at: '2026-08-21' }
    expect(itemTimeStr(item)).toBe('')
  })

  it('returns empty string when no datetime at all', () => {
    const item = { kind: 'note', details: {}, scheduled_at: null }
    expect(itemTimeStr(item)).toBe('')
  })

  it('returns midnight as empty (date-only stored as T00:00)', () => {
    const item = { kind: 'transfer', details: {}, scheduled_at: '2026-08-22T00:00' }
    expect(itemTimeStr(item)).toBe('')
  })
})

// ── itemDateKey ──────────────────────────────────────────────────────────────

describe('itemDateKey', () => {
  it('extracts date from flight depart_time', () => {
    const item = { kind: 'flight', details: { depart_time: '2026-08-19T16:25' }, scheduled_at: null }
    expect(itemDateKey(item)).toBe('2026-08-19')
  })

  it('extracts date from scheduled_at for activities', () => {
    const item = { kind: 'activity', details: {}, scheduled_at: '2026-08-21T14:30' }
    expect(itemDateKey(item)).toBe('2026-08-21')
  })

  it('returns null when no datetime', () => {
    const item = { kind: 'note', details: {}, scheduled_at: null }
    expect(itemDateKey(item)).toBeNull()
  })
})

// ── computeLayovers ──────────────────────────────────────────────────────────

describe('computeLayovers', () => {
  const flight = (id, depart, arrive, origin = 'CDG', destination = 'DOH') => ({
    id,
    kind: 'flight',
    scheduled_at: null,
    details: { depart_time: depart, arrive_time: arrive, origin, destination },
  })
  const transfer = (id, scheduled_at) => ({
    id, kind: 'transfer', scheduled_at, details: {},
  })

  it('detects a connection between two flights within 24h', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:30', 'SYD', 'MEL'),
      flight(2, '2026-08-19T14:00', '2026-08-19T22:00', 'MEL', 'DOH'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeDefined()
    expect(result[1].duration).toBe('3h 30m')
    expect(result[1].location).toMatch(/Melbourne/)
  })

  it('ignores connections longer than 24h', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:00', 'SYD', 'MEL'),
      flight(2, '2026-08-21T08:00', '2026-08-21T14:00', 'MEL', 'DOH'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeUndefined()
  })

  it('sorts items by UTC before computing (out-of-order input is handled)', () => {
    // Pass items in wrong order — algorithm should re-sort and find the 3h 30m connection
    const items = [
      flight(1, '2026-08-19T14:00', '2026-08-19T22:00', 'MEL', 'DOH'),
      flight(2, '2026-08-19T08:00', '2026-08-19T10:30', 'SYD', 'MEL'),
    ]
    const result = computeLayovers(items)
    // After sorting, flight 2 (08:00) precedes flight 1 (14:00) — 3h 30m connection
    expect(result[2]).toBeDefined()
    expect(result[2].duration).toBe('3h 30m')
  })

  it('shows no connection when the next item starts before the transport arrives', () => {
    // Train arrives 10:03; next items at 09:59 and 10:00 — all before arrival, skip
    const rail = (id, depart, arrive) => ({
      id, kind: 'rail', scheduled_at: null,
      details: { depart_time: depart, arrive_time: arrive, origin: 'LYS', destination: 'MAK' },
    })
    const items = [
      rail(1, '2026-08-05T09:16', '2026-08-05T10:03'),
      { id: 2, kind: 'cycling', details: {}, scheduled_at: '2026-08-05T09:59' },
      { id: 3, kind: 'note',    details: {}, scheduled_at: '2026-08-05T10:00' },
      { id: 4, kind: 'cycling', details: {}, scheduled_at: '2026-08-05T12:15' },
    ]
    const result = computeLayovers(items)
    // The immediately next item (09:59) starts before the 10:03 arrival → no connection
    expect(result[1]).toBeUndefined()
  })

  it('ignores a flight whose arrival is after the next item starts', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T22:00', 'SYD', 'MEL'),
      { id: 2, kind: 'activity', details: {}, scheduled_at: '2026-08-19T20:00' },
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeUndefined()
  })

  it('works across flight + transfer pairs', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:00', 'SYD', 'MEL'),
      transfer(2, '2026-08-19T12:00'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeDefined()
    expect(result[1].duration).toBe('2h')
  })

  it('caps connection at next non-transport activity, not the subsequent flight', () => {
    // Flight arrives 10:00; restaurant at 11:00; next flight at 13:00
    // Connection should be 1h (to restaurant), not 3h (to next flight)
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:00', 'SYD', 'MEL'),
      { id: 99, kind: 'restaurant', details: {}, scheduled_at: '2026-08-19T11:00' },
      flight(2, '2026-08-19T13:00', '2026-08-19T22:00', 'MEL', 'DOH'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeDefined()
    expect(result[1].duration).toBe('1h')  // to restaurant, not to flight 2
    expect(result[99]).toBeUndefined()
  })
})

// ── toUtcMs ──────────────────────────────────────────────────────────────────

describe('toUtcMs', () => {
  it('treats no-tz datetime as UTC', () => {
    expect(toUtcMs('2026-07-25T07:35', null)).toBe(new Date('2026-07-25T07:35Z').getTime())
  })

  it('subtracts positive offset to get UTC (GMT+3 → local - 3h = UTC)', () => {
    const local = new Date('2026-07-25T07:35Z').getTime()
    const expected = local - 3 * 3600000
    expect(toUtcMs('2026-07-25T07:35', 'GMT+3')).toBe(expected)
  })

  it('adds negative offset to get UTC (GMT-5 → local + 5h = UTC)', () => {
    const local = new Date('2026-07-25T07:35Z').getTime()
    const expected = local + 5 * 3600000
    expect(toUtcMs('2026-07-25T07:35', 'GMT-5')).toBe(expected)
  })

  it('orders a GMT+10 flight before GMT+2 flight that has a later local time', () => {
    // SGT 21:35 (GMT+8) = 13:35 UTC; HEL 07:35 (GMT+3) next day = 04:35 UTC
    const sgtDep = toUtcMs('2026-07-24T21:35', 'GMT+8')   // 13:35 UTC Jul 24
    const helDep = toUtcMs('2026-07-25T07:35', 'GMT+3')   // 04:35 UTC Jul 25
    expect(sgtDep).toBeLessThan(helDep)
  })
})

// ── fmtConnectionDur ─────────────────────────────────────────────────────────

describe('fmtConnectionDur', () => {
  it('formats hours and minutes', () => expect(fmtConnectionDur(5700000)).toBe('1h 35m'))
  it('formats whole hours', ()        => expect(fmtConnectionDur(7200000)).toBe('2h'))
  it('formats minutes only', ()       => expect(fmtConnectionDur(2700000)).toBe('45m'))
})

// ── computeCrossStopLayover ───────────────────────────────────────────────────

describe('computeCrossStopLayover', () => {
  const mkFlight = (id, depart, arrive, dest = 'HEL') => ({
    id, kind: 'flight', scheduled_at: null,
    details: { depart_time: depart, arrive_time: arrive, destination: dest },
  })

  it('detects a connection between the last arrival in stop A and first departure in stop B', () => {
    const stopA = { items: [mkFlight(1, '2026-07-24T21:35', '2026-07-25T06:00', 'HEL')] }
    const stopB = { items: [mkFlight(2, '2026-07-25T07:35', '2026-07-25T09:40', 'CDG')] }
    const result = computeCrossStopLayover(stopA, stopB)
    expect(result).not.toBeNull()
    expect(result.duration).toBe('1h 35m')
    expect(result.location).toMatch(/Helsinki/)
  })

  it('returns null when gap is more than 24h', () => {
    const stopA = { items: [mkFlight(1, '2026-07-24T08:00', '2026-07-24T10:00', 'HEL')] }
    const stopB = { items: [mkFlight(2, '2026-07-26T08:00', '2026-07-26T12:00', 'CDG')] }
    expect(computeCrossStopLayover(stopA, stopB)).toBeNull()
  })

  it('returns null when stop A has no transport arrivals', () => {
    const stopA = { items: [{ id: 1, kind: 'restaurant', details: {}, scheduled_at: '2026-07-24T19:00' }] }
    const stopB = { items: [mkFlight(2, '2026-07-25T07:35', '2026-07-25T09:40', 'CDG')] }
    expect(computeCrossStopLayover(stopA, stopB)).toBeNull()
  })

  it('returns null when stop B has no transport departures', () => {
    const stopA = { items: [mkFlight(1, '2026-07-24T21:35', '2026-07-25T06:00', 'HEL')] }
    const stopB = { items: [{ id: 2, kind: 'accommodation', details: {}, scheduled_at: null }] }
    expect(computeCrossStopLayover(stopA, stopB)).toBeNull()
  })

  it('uses the latest arrival when stop A has multiple transport items', () => {
    const stopA = {
      items: [
        mkFlight(1, '2026-07-24T10:00', '2026-07-24T12:00', 'SIN'),
        mkFlight(2, '2026-07-24T21:35', '2026-07-25T06:00', 'HEL'),
      ],
    }
    const stopB = { items: [mkFlight(3, '2026-07-25T07:35', '2026-07-25T09:40', 'CDG')] }
    const result = computeCrossStopLayover(stopA, stopB)
    expect(result.duration).toBe('1h 35m') // from 06:00 not 12:00
  })
})

// ── HideTimeCtx — framed vs frameless ────────────────────────────────────────

describe('HideTimeCtx', () => {
  function ReadCtx() {
    const v = useContext(HideTimeCtx)
    return <span data-testid="val">{String(v)}</span>
  }

  it('is false by default (framed / full-width card view)', () => {
    render(<ReadCtx />)
    expect(screen.getByTestId('val').textContent).toBe('false')
  })

  it('is true when rendered inside HideTimeCtx.Provider', () => {
    render(
      <HideTimeCtx.Provider value={true}>
        <ReadCtx />
      </HideTimeCtx.Provider>
    )
    expect(screen.getByTestId('val').textContent).toBe('true')
  })
})
