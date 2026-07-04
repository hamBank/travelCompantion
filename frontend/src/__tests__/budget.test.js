import { describe, it, expect } from 'vitest'
import { aggregateSpend } from '../budget.js'

describe('aggregateSpend', () => {
  it('uses converted_cost/converted_amount_paid when present and currency matches home', () => {
    const items = [
      {
        name: 'Hotel',
        kind: 'accommodation',
        cost: '500 EUR',
        details: {
          converted_cost: 800,
          converted_currency: 'AUD',
          amount_paid: '200 EUR',
          converted_amount_paid: 320,
        },
      },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.planned).toBe(800)
    expect(result.paid).toBe(320)
    expect(result.unconvertible).toEqual([])
  })

  it('parses the raw cost string directly when already in the home currency', () => {
    const items = [
      { name: 'Dinner', kind: 'restaurant', cost: '120 AUD', details: {} },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.planned).toBe(120)
    expect(result.paid).toBe(0)
  })

  it('buckets foreign-currency costs with no conversion into unconvertible', () => {
    const items = [
      { name: 'Museum ticket', kind: 'activity', cost: '30 USD', details: {} },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.planned).toBe(0)
    expect(result.unconvertible).toEqual(['Museum ticket'])
  })

  it('groups planned/paid totals by item kind', () => {
    const items = [
      { name: 'Hotel', kind: 'accommodation', cost: '100 AUD', details: {} },
      { name: 'Hostel', kind: 'accommodation', cost: '50 AUD', details: {} },
      { name: 'Dinner', kind: 'restaurant', cost: '40 AUD', details: {} },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.byKind.accommodation.planned).toBe(150)
    expect(result.byKind.restaurant.planned).toBe(40)
  })

  it('does not enforce paid <= planned', () => {
    const items = [
      {
        name: 'Flight',
        kind: 'flight',
        cost: '200 AUD',
        details: { amount_paid: '250 AUD' },
      },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.planned).toBe(200)
    expect(result.paid).toBe(250)
  })

  it('skips items with no cost', () => {
    const items = [{ name: 'Free walk', kind: 'activity', cost: null, details: {} }]
    const result = aggregateSpend(items, 'AUD')
    expect(result.planned).toBe(0)
    expect(result.byKind).toEqual({})
  })
})
