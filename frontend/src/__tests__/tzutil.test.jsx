import { describe, it, expect } from 'vitest'
import { approxUtcOffsetHours, approxLocalDateStr } from '../tzutil.js'

describe('approxUtcOffsetHours', () => {
  it('is zero at the prime meridian', () => {
    expect(approxUtcOffsetHours(0)).toBe(0)
  })

  it('rounds to the nearest zone for an eastern longitude', () => {
    expect(approxUtcOffsetHours(103.8198)).toBe(7) // Singapore-ish
  })

  it('is negative for a western longitude', () => {
    expect(approxUtcOffsetHours(-74.0)).toBe(-5) // New York-ish
  })

  it('clamps to real-world offset limits', () => {
    expect(approxUtcOffsetHours(300)).toBe(14)
    expect(approxUtcOffsetHours(-300)).toBe(-12)
  })
})

describe('approxLocalDateStr', () => {
  it('shifts forward into the next day for an eastern longitude', () => {
    const now = new Date('2026-07-06T23:00:00Z')
    expect(approxLocalDateStr(103.8198, now)).toBe('2026-07-07')
  })

  it('stays on the previous day for a western longitude', () => {
    const now = new Date('2026-07-07T02:00:00Z')
    expect(approxLocalDateStr(-74.0, now)).toBe('2026-07-06')
  })

  it('falls back to the browser-local date when lng is missing', () => {
    const now = new Date('2026-07-06T12:00:00Z')
    expect(approxLocalDateStr(null, now)).toBe(now.toLocaleDateString('sv-SE'))
  })
})
