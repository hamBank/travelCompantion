import { describe, it, expect } from 'vitest'
import { fmtDay, fmtDayTime } from '../dates.js'

describe('fmtDay', () => {
  it('formats an ISO date as "Wkd D Mon"', () => {
    expect(fmtDay('2026-08-04')).toBe('Tue 4 Aug')
  })
  it('accepts a full datetime and ignores the time', () => {
    expect(fmtDay('2026-08-04T17:15')).toBe('Tue 4 Aug')
  })
  it('returns null for empty or invalid input', () => {
    expect(fmtDay(null)).toBeNull()
    expect(fmtDay('')).toBeNull()
    expect(fmtDay('not-a-date')).toBeNull()
  })
})

describe('fmtDayTime', () => {
  it('appends a meaningful time', () => {
    expect(fmtDayTime('2026-08-04T17:15')).toBe('Tue 4 Aug 17:15')
  })
  it('suppresses a midnight / absent time', () => {
    expect(fmtDayTime('2026-08-04T00:00')).toBe('Tue 4 Aug')
    expect(fmtDayTime('2026-08-04T00:00:00')).toBe('Tue 4 Aug')
    expect(fmtDayTime('2026-08-04')).toBe('Tue 4 Aug')
  })
  it('returns null for empty input', () => {
    expect(fmtDayTime(null)).toBeNull()
  })
})
