import { describe, it, expect } from 'vitest'
import { parseCheckinWindow, calcCheckinTime } from '../checkin.js'

describe('parseCheckinWindow', () => {
  it('parses plain hours number', () => expect(parseCheckinWindow('48')).toBe(48))
  it('parses "h" suffix', () => expect(parseCheckinWindow('24h')).toBe(24))
  it('parses "hr" suffix', () => expect(parseCheckinWindow('48hr')).toBe(48))
  it('parses "hours" suffix', () => expect(parseCheckinWindow('36 hours')).toBe(36))
  it('parses days', () => expect(parseCheckinWindow('2d')).toBe(48))
  it('parses "days" suffix', () => expect(parseCheckinWindow('2 days')).toBe(48))
  it('returns null for empty', () => expect(parseCheckinWindow('')).toBeNull())
  it('returns null for null', () => expect(parseCheckinWindow(null)).toBeNull())
  it('returns null for nonsense', () => expect(parseCheckinWindow('unknown')).toBeNull())
})

describe('calcCheckinTime', () => {
  it('subtracts hours from departure time', () => {
    // depart Mon 24 Aug 21:35, 48h window → Sat 22 Aug 21:35
    const result = calcCheckinTime('2026-08-24T21:35', 48)
    expect(result).toBe('2026-08-22T21:35')
  })

  it('handles midnight boundary correctly', () => {
    // depart 2026-08-04T06:20, 24h window → 2026-08-03T06:20
    const result = calcCheckinTime('2026-08-04T06:20', 24)
    expect(result).toBe('2026-08-03T06:20')
  })

  it('returns null when depart_time is missing', () => {
    expect(calcCheckinTime(null, 48)).toBeNull()
    expect(calcCheckinTime('', 48)).toBeNull()
  })

  it('returns null when hours is null', () => {
    expect(calcCheckinTime('2026-08-24T21:35', null)).toBeNull()
  })
})
