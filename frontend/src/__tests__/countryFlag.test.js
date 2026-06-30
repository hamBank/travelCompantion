import { describe, it, expect } from 'vitest'
import { countryFlag, countryCode } from '../countryFlag.js'

describe('countryFlag', () => {
  it('maps known countries to emoji (case-insensitive)', () => {
    expect(countryFlag('Italy')).toBe('🇮🇹')
    expect(countryFlag(' france ')).toBe('🇫🇷')
  })
  it('returns empty for unknown/blank', () => {
    expect(countryFlag('Atlantis')).toBe('')
    expect(countryFlag('')).toBe('')
  })
})

describe('countryCode', () => {
  it('derives the ISO-2 code from the flag emoji', () => {
    expect(countryCode('Singapore')).toBe('sg')
    expect(countryCode('France')).toBe('fr')
    expect(countryCode('Italy')).toBe('it')
    expect(countryCode('Australia')).toBe('au')
  })
  it('returns empty for unknown/blank', () => {
    expect(countryCode('Atlantis')).toBe('')
    expect(countryCode('')).toBe('')
  })
})
