import { describe, it, expect } from 'vitest'
import { parseBaggage, aggregateBaggage } from '../baggage.js'

describe('parseBaggage', () => {
  it('parses simple kg', () => expect(parseBaggage('23kg')).toMatchObject({ holdBags: 1, holdKg: 23, carryOn: false }))
  it('parses kg with space', () => expect(parseBaggage('23 kg')).toMatchObject({ holdBags: 1, holdKg: 23 }))
  it('parses multiplied N x Xkg', () => expect(parseBaggage('2 x 23kg')).toMatchObject({ holdBags: 2, holdKg: 23 }))
  it('parses unicode times ×', () => expect(parseBaggage('2 × 32kg')).toMatchObject({ holdBags: 2, holdKg: 32 }))
  it('parses bags no weight', () => expect(parseBaggage('2 bags')).toMatchObject({ holdBags: 2, holdKg: null }))
  it('parses pieces with weight', () => expect(parseBaggage('1 piece 23kg')).toMatchObject({ holdBags: 1, holdKg: 23 }))
  it('ignores qualifier text', () => expect(parseBaggage('40kg international Business (Non FF/Bronze)')).toMatchObject({ holdBags: 1, holdKg: 40 }))
  it('parses carry-on only', () => expect(parseBaggage('carry-on')).toMatchObject({ holdBags: 0, carryOn: true }))
  it('parses cabin bag', () => expect(parseBaggage('cabin bag')).toMatchObject({ holdBags: 0, carryOn: true }))
  it('handles empty string', () => expect(parseBaggage('')).toMatchObject({ holdBags: 0, holdKg: null, carryOn: false }))
  it('handles null', () => expect(parseBaggage(null)).toMatchObject({ holdBags: 0, holdKg: null, carryOn: false }))
  it('parses "2x checked bag max 32kg"', () => expect(parseBaggage('2x checked bag max 32kg')).toMatchObject({ holdBags: 2, holdKg: 32 }))
  // Airline shorthand: K instead of kg
  it('parses "40K" (airline shorthand)', () => expect(parseBaggage('40K')).toMatchObject({ holdBags: 1, holdKg: 40, carryOn: false }))
  it('parses "2 x 23K"', () => expect(parseBaggage('2 x 23K')).toMatchObject({ holdBags: 2, holdKg: 23 }))
})

describe('aggregateBaggage', () => {
  it('sums two passengers with same allowance', () => {
    expect(aggregateBaggage([
      { name: 'Mr A', baggage: '23kg' },
      { name: 'Mrs B', baggage: '23kg' },
    ])).toBe('2 bags (46kg checked)')
  })

  it('handles different allowances', () => {
    expect(aggregateBaggage([
      { name: 'Mr A', baggage: '32kg' },
      { name: 'Mrs B', baggage: '23kg' },
    ])).toBe('2 bags (55kg checked)')
  })

  it('sums multiplied format', () => {
    expect(aggregateBaggage([
      { name: 'Mr A', baggage: '2 x 32kg' },
      { name: 'Mrs B', baggage: '2 x 32kg' },
    ])).toBe('4 bags (128kg checked)')
  })

  it('shows carry-on separately', () => {
    expect(aggregateBaggage([
      { name: 'Mr A', baggage: '23kg' },
      { name: 'Mrs B', baggage: 'carry-on' },
    ])).toBe('1 bag (23kg checked) · carry-on')
  })

  it('handles carry-on only', () => {
    expect(aggregateBaggage([
      { name: 'Mr A', baggage: 'carry-on' },
      { name: 'Mrs B', baggage: 'cabin bag' },
    ])).toBe('carry-on')
  })

  it('returns null when no baggage fields', () => {
    expect(aggregateBaggage([{ name: 'Mr A', seat: '14A' }])).toBeNull()
  })

  it('returns null for empty list', () => expect(aggregateBaggage([])).toBeNull())
  it('returns null for non-array', () => expect(aggregateBaggage('legacy string')).toBeNull())

  it('handles bags without weight', () => {
    expect(aggregateBaggage([
      { name: 'Mr A', baggage: '2 bags' },
      { name: 'Mrs B', baggage: '2 bags' },
    ])).toBe('4 bags checked')
  })

  it('mixed - some have weight some don\'t', () => {
    // When any passenger has kg, show total for those; bags without kg add to count only
    const result = aggregateBaggage([
      { name: 'Mr A', baggage: '23kg' },
      { name: 'Mrs B', baggage: '1 bag' },
    ])
    expect(result).toContain('2 bags')
  })
})
