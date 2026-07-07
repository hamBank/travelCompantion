import { describe, it, expect } from 'vitest'
import { pickInitialDay, shiftDay, clampedShiftDay } from '../components/TripTimeline.jsx'

const REAL_DATE = Date
const REAL_TO_LOCALE_DATE_STRING = Date.prototype.toLocaleDateString

// Mocks the epoch instant `new Date()`/`Date.now()` resolve to — this is what
// tzutil.js's approxLocalDateStr uses (pure epoch math, already
// timezone-agnostic) but is NOT enough on its own to control
// pickInitialDay's *device*-local guess, which calls
// `new Date().toLocaleDateString('sv-SE')` — that still resolves against
// whatever OS timezone the test happens to run under. Use
// mockDeviceLocalDate below alongside this to pin that down too.
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

// Pins `toLocaleDateString('sv-SE')` to a fixed string, decoupling the
// "device's local day" guess from the test runner's actual OS timezone
// (this repo's dev machines and CI don't all run in UTC — a test that
// hardcodes a UTC assumption here is flaky by construction).
//
// Must patch REAL_DATE.prototype specifically, not the ambient `Date`
// global — by the time this runs, mockToday has already reassigned
// `global.Date` to MockDate, and MockDate's constructor returns a
// `new REAL_DATE(iso)` instance, whose prototype chain is REAL_DATE.prototype
// regardless of what `Date` currently points to.
function mockDeviceLocalDate(dateStr) {
  REAL_DATE.prototype.toLocaleDateString = function (...args) {
    if (args[0] === 'sv-SE') return dateStr
    return REAL_TO_LOCALE_DATE_STRING.apply(this, args)
  }
}

function restoreDate() {
  global.Date = REAL_DATE
  REAL_DATE.prototype.toLocaleDateString = REAL_TO_LOCALE_DATE_STRING
}

describe('pickInitialDay', () => {
  it('uses today when it falls within the trip dates', () => {
    mockToday('2026-07-10T12:00:00')
    mockDeviceLocalDate('2026-07-10')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: '2026-07-20T00:00:00' })).toBe('2026-07-10')
    } finally { restoreDate() }
  })

  it('defaults to the trip start when today is before the trip starts', () => {
    mockToday('2026-06-01T12:00:00')
    mockDeviceLocalDate('2026-06-01')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: '2026-07-20T00:00:00' })).toBe('2026-07-01')
    } finally { restoreDate() }
  })

  it('defaults to the trip start when today is after the trip ends', () => {
    mockToday('2026-08-01T12:00:00')
    mockDeviceLocalDate('2026-08-01')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: '2026-07-20T00:00:00' })).toBe('2026-07-01')
    } finally { restoreDate() }
  })

  it('falls back to today when the trip has no dates set', () => {
    mockToday('2026-08-01T12:00:00')
    mockDeviceLocalDate('2026-08-01')
    try {
      expect(pickInitialDay({ start_date: null, end_date: null })).toBe('2026-08-01')
    } finally { restoreDate() }
  })

  it('uses today for an open-ended trip that has already started', () => {
    mockToday('2026-09-01T12:00:00')
    mockDeviceLocalDate('2026-09-01')
    try {
      expect(pickInitialDay({ start_date: '2026-07-01T00:00:00', end_date: null })).toBe('2026-09-01')
    } finally { restoreDate() }
  })

  it("refines the default day using the current stop's longitude when it disagrees with the device's local date", () => {
    // 23:30 UTC on the 6th is already past midnight (the 7th) at a
    // Singapore-ish longitude — the device says the 6th (mocked explicitly,
    // independent of the test runner's real OS timezone), but the stop the
    // trip is actually at says the 7th.
    mockToday('2026-07-06T23:30:00Z')
    mockDeviceLocalDate('2026-07-06')
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
    mockDeviceLocalDate('2026-07-06')
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
    mockDeviceLocalDate('2026-07-06')
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
