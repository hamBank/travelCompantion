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

  it('tracks each original currency separately, including ones with no home conversion', () => {
    const items = [
      { name: 'Dinner', kind: 'restaurant', cost: '120 AUD', details: {} },
      { name: 'Museum ticket', kind: 'activity', cost: '30 USD', details: {} },
      { name: 'Hostel', kind: 'accommodation', cost: '200 USD', details: {} },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.byCurrency.AUD.planned).toBe(120)
    expect(result.byCurrency.USD.planned).toBe(230)
    expect(result.unconvertible).toEqual(['Museum ticket', 'Hostel'])
  })

  it('tracks paid amounts by their own currency, separately from the cost currency', () => {
    const items = [
      {
        name: 'Hotel', kind: 'accommodation', cost: '500 EUR',
        details: { amount_paid: '200 EUR' },
      },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.byCurrency.EUR.planned).toBe(500)
    expect(result.byCurrency.EUR.paid).toBe(200)
  })

  it('buckets a cost string with no recognisable currency as unconvertible', () => {
    const items = [{ name: 'Snack', kind: 'food', cost: '15', details: {} }]
    const result = aggregateSpend(items, 'AUD')
    expect(result.unconvertible).toEqual(['Snack'])
  })

  it('treats a bare $ cost as the home currency rather than defaulting to USD', () => {
    const items = [{ name: 'Groceries', kind: 'purchase', cost: '$2,017.50', details: {} }]
    const result = aggregateSpend(items, 'AUD')
    expect(result.planned).toBe(2017.5)
    expect(result.byCurrency.AUD.planned).toBe(2017.5)
    expect(result.unconvertible).toEqual([])
  })

  it('treats a bare "0" cost as zero rather than unconvertible (e.g. a connecting flight leg)', () => {
    const items = [
      { name: 'CDG → DOH', kind: 'flight', cost: '$2,017.50', details: {} },
      { name: 'DOH → PER', kind: 'flight', cost: '0', details: {} },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.planned).toBe(2017.5)
    expect(result.unconvertible).toEqual([])
  })
})
