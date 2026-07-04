import { describe, it, expect } from 'vitest'
import { pickInitialDay, shiftDay, clampedShiftDay } from '../components/TripTimeline.jsx'

const REAL_DATE = Date

function mockToday(iso) {
  class MockDate extends REAL_DATE {
    constructor(...args) {
      if (args.length === 0) return new REAL_DATE(iso)
      return new REAL_DATE(...args)
    }
    static now() { return new REAL_DATE(iso).getTime() }
  }
  global.Date = MockDate
}

function restoreDate() { global.Date = REAL_DATE }

describe('pickInitialDay', () => {
  it('uses today when it falls within the trip dates', () => {
    mockToday('2026-07-10T12:00:00')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: '2026-07-20T00:00:00' })).toBe('2026-07-10')
    } finally { restoreDate() }
  })

  it('defaults to the trip start when today is before the trip starts', () => {
    mockToday('2026-06-01T12:00:00')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: '2026-07-20T00:00:00' })).toBe('2026-07-01')
    } finally { restoreDate() }
  })

  it('defaults to the trip start when today is after the trip ends', () => {
    mockToday('2026-08-01T12:00:00')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: '2026-07-20T00:00:00' })).toBe('2026-07-01')
    } finally { restoreDate() }
  })

  it('falls back to today when the trip has no dates set', () => {
    mockToday('2026-08-01T12:00:00')
    try {
      expect(pickInitialDay({ start_date: null, end_date: null })).toBe('2026-08-01')
    } finally { restoreDate() }
  })

  it('uses today for an open-ended trip that has already started', () => {
    mockToday('2026-09-01T12:00:00')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: null })).toBe('2026-09-01')
    } finally { restoreDate() }
  })
})

describe('shiftDay', () => {
  it('adds days', () => {
    expect(shiftDay('2026-07-10', 1)).toBe('2026-07-11')
  })
  it('subtracts days', () => {
    expect(shiftDay('2026-07-10', -1)).toBe('2026-07-09')
  })
  it('crosses a month boundary', () => {
    expect(shiftDay('2026-07-31', 1)).toBe('2026-08-01')
  })
})

describe('clampedShiftDay', () => {
  const timeline = { start_date: '2026-07-01T00:00:00', end_date: '2026-07-03T00:00:00' }

  it('moves forward within bounds', () => {
    expect(clampedShiftDay('2026-07-01', 'next', timeline)).toBe('2026-07-02')
  })

  it('refuses to move past the trip end', () => {
    expect(clampedShiftDay('2026-07-03', 'next', timeline)).toBe('2026-07-03')
  })

  it('refuses to move before the trip start', () => {
    expect(clampedShiftDay('2026-07-01', 'prev', timeline)).toBe('2026-07-01')
  })

  it('is unbounded when the trip has no dates set', () => {
    expect(clampedShiftDay('2026-07-01', 'prev', { start_date: null, end_date: null })).toBe('2026-06-30')
  })
})
