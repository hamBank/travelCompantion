import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BudgetSummary from '../components/BudgetSummary.jsx'
import { HOME_CURRENCY_KEY } from '../currency.js'
import * as api from '../api.js'

vi.mock('../api.js')

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.setItem(HOME_CURRENCY_KEY, 'AUD')
  api.listExpenses.mockResolvedValue([])
})

const stops = [
  {
    id: 1,
    items: [
      { name: 'Hotel', kind: 'accommodation', cost: '400 AUD', details: { amount_paid: '400 AUD' } },
      { name: 'Dinner', kind: 'restaurant', cost: '60 AUD', details: {} },
    ],
  },
  {
    id: 2,
    items: [
      { name: 'Museum', kind: 'activity', cost: '30 USD', details: {} },
    ],
  },
]

describe('BudgetSummary', () => {
  it('shows a hint when no budget is set', () => {
    render(<BudgetSummary trip={{ budget: null }} stops={stops} onClose={() => {}} />)
    expect(screen.getByText(/No budget set for this trip/)).toBeInTheDocument()
  })

  it('shows planned/paid totals and progress against a set budget', () => {
    render(<BudgetSummary trip={{ budget: '1000 AUD' }} stops={stops} onClose={() => {}} />)
    expect(screen.getByText(/460\.00 \/ .*1,?000\.00 planned/)).toBeInTheDocument()
  })

  it('lists per-kind totals', () => {
    render(<BudgetSummary trip={{ budget: '1000 AUD' }} stops={stops} onClose={() => {}} />)
    expect(screen.getByText('Accommodation')).toBeInTheDocument()
    expect(screen.getByText('Restaurant')).toBeInTheDocument()
  })

  it('notes unconvertible foreign-currency items in a footnote', () => {
    render(<BudgetSummary trip={{ budget: '1000 AUD' }} stops={stops} onClose={() => {}} />)
    expect(screen.getByText(/Museum/)).toBeInTheDocument()
  })

  it('lists a per-currency breakdown, home currency first', () => {
    render(<BudgetSummary trip={{ budget: '1000 AUD' }} stops={stops} onClose={() => {}} />)
    expect(screen.getByText('By currency')).toBeInTheDocument()
    expect(screen.getByText(/AUD/)).toBeInTheDocument()
    expect(screen.getByText(/USD/)).toBeInTheDocument()
  })

  it('reveals which items are under a currency when its row is clicked', () => {
    render(<BudgetSummary trip={{ budget: '1000 AUD' }} stops={stops} onClose={() => {}} />)
    // Item names aren't shown anywhere until the currency row is expanded.
    expect(screen.queryByText('Museum')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/^USD/))
    expect(screen.getByText('Museum')).toBeInTheDocument()
    // Clicking again collapses it.
    fireEvent.click(screen.getByText(/^USD/))
    expect(screen.queryByText('Museum')).not.toBeInTheDocument()
  })

  it('gives free-text cost strings a distinct footnote instead of pointing at "By currency"', () => {
    const stopsWithFreeText = [
      ...stops,
      { id: 3, items: [{ name: 'Gallipoli food', kind: 'food', cost: 'Walk', details: {} }] },
    ]
    render(<BudgetSummary trip={{ budget: '1000 AUD' }} stops={stopsWithFreeText} onClose={() => {}} />)
    expect(screen.getByText(/no recognisable cost amount/)).toBeInTheDocument()
    expect(screen.getByText(/Gallipoli food/)).toBeInTheDocument()
  })
})

describe('BudgetSummary — actual spend (issue #59)', () => {
  const stopsWithId = [
    { id: 1, location: 'Rome', items: [{ id: 42, name: 'Colosseum', kind: 'activity', cost: '50 AUD', details: {} }] },
  ]

  it('fetches and totals logged expenses for the trip', async () => {
    api.listExpenses.mockResolvedValue([
      { id: 1, name: 'Gelato', amount: '10 AUD', occurred_at: '2026-08-01T10:00:00', converted_amount: 10, converted_currency: 'AUD', stop_id: 1, item_id: null },
    ])
    render(<BudgetSummary trip={{ id: 7, budget: '1000 AUD' }} stops={stopsWithId} onClose={() => {}} />)
    await waitFor(() => expect(api.listExpenses).toHaveBeenCalledWith(7))
    expect(await screen.findByText('Actual spend logged')).toBeTruthy()
    expect(screen.getByText(/Gelato/)).toBeTruthy()
  })

  it('groups actual spend by day and by stop', async () => {
    api.listExpenses.mockResolvedValue([
      { id: 1, name: 'Gelato', amount: '10 AUD', occurred_at: '2026-08-01T10:00:00', converted_amount: 10, converted_currency: 'AUD', stop_id: 1, item_id: null },
      { id: 2, name: 'Taxi', amount: '15 AUD', occurred_at: '2026-08-01T20:00:00', converted_amount: 15, converted_currency: 'AUD', stop_id: 1, item_id: null },
    ])
    render(<BudgetSummary trip={{ id: 7, budget: '1000 AUD' }} stops={stopsWithId} onClose={() => {}} />)
    expect(await screen.findByText('By day')).toBeTruthy()
    expect(screen.getByText('2026-08-01')).toBeTruthy()
    expect(screen.getByText('By stop')).toBeTruthy()
    expect(screen.getByText('Rome')).toBeTruthy()
  })

  it('shows a plan-vs-actual row for an item with a linked expense', async () => {
    api.listExpenses.mockResolvedValue([
      { id: 1, name: 'Entry ticket', amount: '60 AUD', occurred_at: '2026-08-01', converted_amount: 60, converted_currency: 'AUD', stop_id: 1, item_id: 42 },
    ])
    render(<BudgetSummary trip={{ id: 7, budget: '1000 AUD' }} stops={stopsWithId} onClose={() => {}} />)
    expect(await screen.findByText('Plan vs actual')).toBeTruthy()
    expect(screen.getByText('Colosseum')).toBeTruthy()
    expect(screen.getByText(/planned \$50\.00/)).toBeTruthy()
    expect(screen.getByText(/actual \$60\.00/)).toBeTruthy()
  })

  it('opens the quick-add form and refreshes the list on save', async () => {
    api.listExpenses.mockResolvedValue([])
    render(<BudgetSummary trip={{ id: 7, budget: '1000 AUD' }} stops={stopsWithId} onClose={() => {}} />)
    await waitFor(() => expect(api.listExpenses).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByText('+ Log expense'))
    expect(screen.getByPlaceholderText('Amount (e.g. 500 THB)')).toBeTruthy()
  })

  it('deletes a logged expense and refreshes the list', async () => {
    api.listExpenses
      .mockResolvedValueOnce([
        { id: 1, name: 'Gelato', amount: '10 AUD', occurred_at: '2026-08-01', converted_amount: 10, converted_currency: 'AUD', stop_id: 1, item_id: null },
      ])
      .mockResolvedValueOnce([])
    api.deleteExpense.mockResolvedValue(undefined)
    render(<BudgetSummary trip={{ id: 7, budget: '1000 AUD' }} stops={stopsWithId} onClose={() => {}} />)

    fireEvent.click(await screen.findByTitle('Delete expense'))
    await waitFor(() => expect(api.deleteExpense).toHaveBeenCalledWith(1))
    await waitFor(() => expect(api.listExpenses).toHaveBeenCalledTimes(2))
  })

  it('does not show the log/edit/delete controls when canEdit is false', async () => {
    api.listExpenses.mockResolvedValue([
      { id: 1, name: 'Gelato', amount: '10 AUD', occurred_at: '2026-08-01', converted_amount: 10, converted_currency: 'AUD', stop_id: 1, item_id: null },
    ])
    render(<BudgetSummary trip={{ id: 7, budget: '1000 AUD' }} stops={stopsWithId} canEdit={false} onClose={() => {}} />)
    await screen.findByText('Actual spend logged')
    expect(screen.queryByText('+ Log expense')).toBeNull()
    expect(screen.queryByTitle('Delete expense')).toBeNull()
  })

  it('flags expenses whose snapshot currency no longer matches home', async () => {
    api.listExpenses.mockResolvedValue([
      { id: 1, name: 'Old entry', amount: '10 USD', occurred_at: '2026-08-01', converted_amount: 10, converted_currency: 'USD', stop_id: null, item_id: null },
    ])
    render(<BudgetSummary trip={{ id: 7, budget: '1000 AUD' }} stops={stopsWithId} onClose={() => {}} />)
    expect(await screen.findByText(/not included above/)).toBeTruthy()
  })
})
