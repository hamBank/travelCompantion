import { describe, it, expect } from 'vitest'
import { aggregateSpend, aggregateExpenses } from '../budget.js'

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

  it('buckets a cost string with no recognisable currency/amount as noRecognizableCost, not unconvertible', () => {
    const items = [{ name: 'Snack', kind: 'food', cost: '15', details: {} }]
    const result = aggregateSpend(items, 'AUD')
    expect(result.unconvertible).toEqual([])
    expect(result.noRecognizableCost).toEqual(['Snack'])
  })

  it('buckets free text stored in the cost field as noRecognizableCost and never counts it', () => {
    const items = [
      { name: 'Restaurant', kind: 'food', cost: 'Walk', details: {} },
      { name: 'Gallipoli food', kind: 'food', cost: "Osteria Sant'Angelo — best meal in town", details: {} },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.noRecognizableCost).toEqual(['Restaurant', 'Gallipoli food'])
    expect(result.unconvertible).toEqual([])
    expect(result.byCurrency).toEqual({})
    expect(result.planned).toBe(0)
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

  it('lists which items were detected under each currency, not just a bare total', () => {
    const items = [
      { name: 'Dinner', kind: 'restaurant', cost: '120 AUD', details: {} },
      { name: 'Museum ticket', kind: 'activity', cost: '30 USD', details: {} },
      { name: 'Hostel', kind: 'accommodation', cost: '200 USD', details: {} },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.byCurrency.AUD.items).toEqual([{ name: 'Dinner', planned: 120, paid: 0 }])
    expect(result.byCurrency.USD.items).toEqual([
      { name: 'Museum ticket', planned: 30, paid: 0 },
      { name: 'Hostel', planned: 200, paid: 0 },
    ])
  })

  it('merges an item\'s cost and paid amounts into one entry when both land in the same currency', () => {
    const items = [
      { name: 'Hotel', kind: 'accommodation', cost: '500 EUR', details: { amount_paid: '200 EUR' } },
    ]
    const result = aggregateSpend(items, 'AUD')
    expect(result.byCurrency.EUR.items).toEqual([{ name: 'Hotel', planned: 500, paid: 200 }])
  })
})

describe('aggregateExpenses', () => {
  it('sums usable expenses (converted_currency matches home) into the total', () => {
    const expenses = [
      { id: 1, occurred_at: '2026-08-01T10:00:00', converted_amount: 20, converted_currency: 'AUD' },
      { id: 2, occurred_at: '2026-08-01T18:00:00', converted_amount: 15, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, [], 'AUD')
    expect(result.total).toBe(35)
    expect(result.staleConversion).toEqual([])
  })

  it('buckets an expense whose snapshot currency no longer matches home into staleConversion', () => {
    const expenses = [
      { id: 1, occurred_at: '2026-08-01T10:00:00', converted_amount: 20, converted_currency: 'USD' },
    ]
    const result = aggregateExpenses(expenses, [], 'AUD')
    expect(result.total).toBe(0)
    expect(result.staleConversion).toHaveLength(1)
    expect(result.staleConversion[0].id).toBe(1)
  })

  it('buckets an expense with no converted_amount at all into staleConversion', () => {
    const expenses = [{ id: 1, occurred_at: '2026-08-01T10:00:00', converted_amount: null, converted_currency: null }]
    const result = aggregateExpenses(expenses, [], 'AUD')
    expect(result.staleConversion).toHaveLength(1)
  })

  it('groups per-day burn by the occurred_at date', () => {
    const expenses = [
      { id: 1, occurred_at: '2026-08-01T09:00:00', converted_amount: 10, converted_currency: 'AUD' },
      { id: 2, occurred_at: '2026-08-01T20:00:00', converted_amount: 5, converted_currency: 'AUD' },
      { id: 3, occurred_at: '2026-08-02T09:00:00', converted_amount: 40, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, [], 'AUD')
    expect(result.byDay).toEqual({ '2026-08-01': 15, '2026-08-02': 40 })
  })

  it('groups per-stop totals, using an empty-string key for unlinked expenses', () => {
    const expenses = [
      { id: 1, occurred_at: '2026-08-01', stop_id: 7, converted_amount: 10, converted_currency: 'AUD' },
      { id: 2, occurred_at: '2026-08-01', stop_id: 7, converted_amount: 5, converted_currency: 'AUD' },
      { id: 3, occurred_at: '2026-08-01', stop_id: null, converted_amount: 20, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, [], 'AUD')
    expect(result.byStop['7'].total).toBe(15)
    expect(result.byStop['7'].expenses).toHaveLength(2)
    expect(result.byStop[''].total).toBe(20)
  })

  it('computes plan-vs-actual for an item with a linked expense, using converted_cost when present', () => {
    const items = [
      { id: 42, name: 'Louvre tickets', cost: '30 EUR', details: { converted_cost: 48, converted_currency: 'AUD' } },
    ]
    const expenses = [
      { id: 1, occurred_at: '2026-08-01', item_id: 42, converted_amount: 50, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, items, 'AUD')
    expect(result.byItem['42']).toEqual({ planned: 48, actual: 50, name: 'Louvre tickets' })
  })

  it('sums multiple expenses linked to the same item', () => {
    const items = [{ id: 1, name: 'Dinner', cost: '100 AUD', details: {} }]
    const expenses = [
      { id: 1, occurred_at: '2026-08-01', item_id: 1, converted_amount: 40, converted_currency: 'AUD' },
      { id: 2, occurred_at: '2026-08-01', item_id: 1, converted_amount: 65, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, items, 'AUD')
    expect(result.byItem['1'].actual).toBe(105)
    expect(result.byItem['1'].planned).toBe(100)
  })

  it('reports planned: null for a linked item with no home-currency cost, without crashing', () => {
    const items = [{ id: 1, name: 'Souvenir', cost: '500 THB', details: {} }]
    const expenses = [
      { id: 1, occurred_at: '2026-08-01', item_id: 1, converted_amount: 21, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, items, 'AUD')
    expect(result.byItem['1'].planned).toBeNull()
    expect(result.byItem['1'].actual).toBe(21)
  })

  it('labels an expense linked to a since-deleted item gracefully', () => {
    const expenses = [
      { id: 1, occurred_at: '2026-08-01', item_id: 999, converted_amount: 10, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, [], 'AUD')
    expect(result.byItem['999'].name).toBe('(deleted item)')
  })

  it('does not count an expense with no item_id toward byItem', () => {
    const expenses = [
      { id: 1, occurred_at: '2026-08-01', item_id: null, converted_amount: 10, converted_currency: 'AUD' },
    ]
    const result = aggregateExpenses(expenses, [], 'AUD')
    expect(result.byItem).toEqual({})
  })
})
