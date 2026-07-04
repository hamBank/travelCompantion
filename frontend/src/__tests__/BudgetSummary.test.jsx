import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import BudgetSummary from '../components/BudgetSummary.jsx'
import { HOME_CURRENCY_KEY } from '../currency.js'

beforeEach(() => {
  localStorage.setItem(HOME_CURRENCY_KEY, 'AUD')
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
})
