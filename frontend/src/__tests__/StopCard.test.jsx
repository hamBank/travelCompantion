import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useContext } from 'react'
import { HideTimeCtx, itemTimeStr, itemDateKey, computeLayovers } from '../components/StopCard.jsx'

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

  it('ignores negative gaps (items out of order)', () => {
    const items = [
      flight(1, '2026-08-19T14:00', '2026-08-19T22:00', 'MEL', 'DOH'),
      flight(2, '2026-08-19T08:00', '2026-08-19T10:30', 'SYD', 'MEL'),
    ]
    const result = computeLayovers(items)
    expect(Object.keys(result)).toHaveLength(0)
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

  it('ignores non-transport items between transport items', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:00', 'SYD', 'MEL'),
      { id: 99, kind: 'restaurant', details: {}, scheduled_at: '2026-08-19T11:00' },
      flight(2, '2026-08-19T13:00', '2026-08-19T22:00', 'MEL', 'DOH'),
    ]
    const result = computeLayovers(items)
    // Connection should still be between flight 1 and flight 2 (3h)
    expect(result[1]).toBeDefined()
    expect(result[1].duration).toBe('3h')
    expect(result[99]).toBeUndefined()
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
