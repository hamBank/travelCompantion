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
  it('does not mistake a non-currency 3-letter label for an ISO code', () => {
    expect(parseCost('~9 min')).toBeNull()
    expect(parseCost('~22 min')).toBeNull()
    expect(parseCost('Est 50')).toBeNull()
  })
  it('parses an ISO code suffix preceded by a label', () => {
    expect(parseCost('Total: 654.66 SGD')).toEqual({ amount: 654.66, code: 'SGD' })
  })
  it('parses an ISO code prefix preceded by a label', () => {
    expect(parseCost('Total: USD 120')).toEqual({ amount: 120, code: 'USD' })
  })
  it('resolves a bare $ to USD when no home currency is given', () => {
    expect(parseCost('$50')).toEqual({ amount: 50, code: 'USD' })
  })
  it('resolves a bare $ to the home currency when home is a dollar currency', () => {
    expect(parseCost('$50', 'AUD')).toEqual({ amount: 50, code: 'AUD' })
    expect(parseCost('$50', 'SGD')).toEqual({ amount: 50, code: 'SGD' })
  })
  it('still defaults a bare $ to USD when home is not a dollar currency', () => {
    expect(parseCost('$50', 'EUR')).toEqual({ amount: 50, code: 'USD' })
  })
  it('does not let a home currency override an explicit disambiguated prefix', () => {
    expect(parseCost('US$50', 'AUD')).toEqual({ amount: 50, code: 'USD' })
    expect(parseCost('A$50', 'USD')).toEqual({ amount: 50, code: 'AUD' })
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
