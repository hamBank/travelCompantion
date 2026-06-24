import { describe, it, expect } from 'vitest'
import { getPowerbankPolicy } from '../powerbank.js'

describe('getPowerbankPolicy', () => {
  it('matches an airline by case-insensitive substring', () => {
    expect(getPowerbankPolicy('Singapore Airlines').source).toBe('Singapore Airlines')
    expect(getPowerbankPolicy('EVA Air').source).toBe('EVA Air')
    expect(getPowerbankPolicy('emirates').source).toBe('Emirates')
  })
  it('falls back to the ICAO default for unknown or missing airlines', () => {
    expect(getPowerbankPolicy('Some Unknown Air').source).toMatch(/ICAO/)
    expect(getPowerbankPolicy(null).source).toMatch(/ICAO/)
    expect(getPowerbankPolicy('').source).toMatch(/ICAO/)
  })
})
