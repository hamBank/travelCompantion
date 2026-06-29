import { describe, it, expect } from 'vitest'
import { relevantDayIndices, filterHoursByDays } from '../washHours.js'

describe('relevantDayIndices', () => {
  it('returns null when no check-in', () => {
    expect(relevantDayIndices(null, null)).toBeNull()
  })

  it('covers single overnight stay', () => {
    // Mon 3 Aug → Tue 4 Aug  (Aug 3 2026 = Monday)
    const days = relevantDayIndices('2026-08-03T15:00', '2026-08-04T12:00')
    expect(days.has(1)).toBe(true)   // Monday
    expect(days.has(2)).toBe(true)   // Tuesday
    expect(days.has(3)).toBe(false)  // Wednesday not included
  })

  it('covers multi-day stay across week boundary', () => {
    // Fri 7 Aug → Mon 10 Aug  (Aug 7 2026 = Friday)
    const days = relevantDayIndices('2026-08-07T15:00', '2026-08-10T11:00')
    expect(days.has(5)).toBe(true)   // Friday
    expect(days.has(6)).toBe(true)   // Saturday
    expect(days.has(0)).toBe(true)   // Sunday
    expect(days.has(1)).toBe(true)   // Monday
    expect(days.has(2)).toBe(false)  // Tuesday not included
  })

  it('covers same-day bag-drop scenario (checkin = checkout date)', () => {
    // Aug 3 2026 = Monday
    const days = relevantDayIndices('2026-08-03T15:00', '2026-08-03T18:00')
    expect(days.has(1)).toBe(true)   // Monday
    expect(days.size).toBe(1)
  })
})

describe('filterHoursByDays', () => {
  const HOURS = [
    'Monday: 7:00 AM – 9:00 PM',
    'Tuesday: 7:00 AM – 9:00 PM',
    'Wednesday: Closed',
    'Thursday: 7:00 AM – 9:00 PM',
    'Friday: 7:00 AM – 10:00 PM',
    'Saturday: 8:00 AM – 8:00 PM',
    'Sunday: Closed',
  ]

  it('returns all when relevantDays is null (no dates set)', () => {
    expect(filterHoursByDays(HOURS, null)).toEqual(HOURS)
  })

  it('filters to Mon–Tue for a two-day stay', () => {
    // Aug 3 = Monday, Aug 4 = Tuesday
    const days = relevantDayIndices('2026-08-03T15:00', '2026-08-04T12:00')
    const result = filterHoursByDays(HOURS, days)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatch(/Monday/)
    expect(result[1]).toMatch(/Tuesday/)
  })

  it('handles legacy string format gracefully (returns as-is)', () => {
    const legacy = 'Monday: 8am-8pm; Tuesday: 8am-8pm'
    const days = new Set([1])
    expect(filterHoursByDays(legacy, days)).toBe(legacy)
  })

  it('returns null/undefined unchanged', () => {
    expect(filterHoursByDays(null, null)).toBeNull()
    expect(filterHoursByDays(undefined, null)).toBeUndefined()
  })
})
