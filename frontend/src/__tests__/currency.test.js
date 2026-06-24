import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseCost, formatCurrencyAmount, isFullyPaid,
  getHomeCurrency, setHomeCurrency,
} from '../currency.js'

describe('parseCost', () => {
  it('parses a symbol prefix', () => {
    expect(parseCost('€48.00')).toEqual({ amount: 48, code: 'EUR' })
  })
  it('parses a disambiguated dollar symbol with thousands separators', () => {
    expect(parseCost('A$1,234.50')).toEqual({ amount: 1234.5, code: 'AUD' })
  })
  it('parses an ISO code prefix and suffix', () => {
    expect(parseCost('EUR 925.00')).toEqual({ amount: 925, code: 'EUR' })
    expect(parseCost('925 EUR')).toEqual({ amount: 925, code: 'EUR' })
  })
  it('returns null when there is no recognisable currency', () => {
    expect(parseCost('')).toBeNull()
    expect(parseCost(null)).toBeNull()
    expect(parseCost('free')).toBeNull()
  })
})

describe('formatCurrencyAmount', () => {
  it('uses a unique prefix symbol', () => {
    expect(formatCurrencyAmount(48, 'EUR')).toBe('€48.00')
  })
  it('omits decimals for zero-decimal currencies', () => {
    expect(formatCurrencyAmount(1000, 'JPY')).toBe('¥1,000')
  })
  it('uses the natural $ at home and a disambiguating prefix abroad', () => {
    expect(formatCurrencyAmount(50, 'USD')).toBe('$50.00')
    expect(formatCurrencyAmount(50, 'AUD', 'USD')).toBe('A$50.00')
    expect(formatCurrencyAmount(50, 'USD', 'USD')).toBe('$50.00')
  })
  it('handles suffix and kr-family symbols', () => {
    expect(formatCurrencyAmount(100, 'PLN')).toBe('100.00 zł')
    expect(formatCurrencyAmount(100, 'SEK')).toBe('100.00 kr')
    expect(formatCurrencyAmount(100, 'SEK', 'NOK')).toBe('100.00 SEK')
  })
})

describe('isFullyPaid', () => {
  it('is true only when the paid amount covers the cost', () => {
    expect(isFullyPaid({ cost: '€100', details: { amount_paid: '€100' } })).toBe(true)
    expect(isFullyPaid({ cost: '€100', details: { amount_paid: '€120' } })).toBe(true)
    expect(isFullyPaid({ cost: '€100', details: { amount_paid: '€50' } })).toBe(false)
  })
  it('is false without a cost or without a paid amount', () => {
    expect(isFullyPaid({ cost: '€100' })).toBe(false)
    expect(isFullyPaid({})).toBe(false)
    expect(isFullyPaid(null)).toBe(false)
  })
})

describe('home currency storage', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips through localStorage', () => {
    expect(getHomeCurrency()).toBe('')
    setHomeCurrency('GBP')
    expect(getHomeCurrency()).toBe('GBP')
  })
})
