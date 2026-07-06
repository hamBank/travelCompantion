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

  it("refines the default day using the current stop's longitude when it disagrees with the device's local date", () => {
    // 23:30 UTC on the 6th is already past midnight (the 7th) at a
    // Singapore-ish longitude — the device (host TZ = UTC in tests) still
    // says the 6th, but the stop the trip is actually at says the 7th.
    mockToday('2026-07-06T23:30:00Z')
    try {
      const timeline = {
        start_date: '2026-07-01T00:00:00',
        end_date: '2026-07-20T00:00:00',
        stops: [{ arrive: '2026-07-06T00:00:00', depart: '2026-07-08T00:00:00', lng: 103.8198 }],
      }
      expect(pickInitialDay(timeline)).toBe('2026-07-07')
    } finally { restoreDate() }
  })

  it('does not refine when the current stop has no stored coordinates', () => {
    mockToday('2026-07-06T23:30:00Z')
    try {
      const timeline = {
        start_date: '2026-07-01T00:00:00',
        end_date: '2026-07-20T00:00:00',
        stops: [{ arrive: '2026-07-06T00:00:00', depart: '2026-07-08T00:00:00', lng: null }],
      }
      expect(pickInitialDay(timeline)).toBe('2026-07-06')
    } finally { restoreDate() }
  })

  it('does not refine when no stop covers the device-local day', () => {
    mockToday('2026-07-06T23:30:00Z')
    try {
      const timeline = {
        start_date: '2026-07-01T00:00:00',
        end_date: '2026-07-20T00:00:00',
        stops: [{ arrive: '2026-07-10T00:00:00', depart: '2026-07-12T00:00:00', lng: 103.8198 }],
      }
      expect(pickInitialDay(timeline)).toBe('2026-07-06')
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
