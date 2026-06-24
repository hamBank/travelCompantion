import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import CostDisplay from '../components/CostDisplay.jsx'

beforeEach(() => localStorage.clear())

describe('CostDisplay', () => {
  it('renders nothing without a cost', () => {
    const { container } = render(<CostDisplay item={{}} />)
    expect(container.textContent).toBe('')
  })

  it('shows the bare cost when there is no paid amount', () => {
    const { container } = render(<CostDisplay item={{ cost: '€450' }} />)
    expect(container.textContent).toContain('€450')
  })

  it('shows the converted amount when present and different from the cost currency', () => {
    const item = { cost: '€450', details: { converted_cost: 375, converted_currency: 'GBP' } }
    const { container } = render(<CostDisplay item={item} />)
    expect(container.textContent).toContain('€450')
    expect(container.textContent).toContain('£375')
  })

  it('marks an item paid in full (compact)', () => {
    const item = { cost: '€100', details: { amount_paid: '€100' } }
    const { container } = render(<CostDisplay item={item} compact />)
    expect(container.textContent).toContain('✓')
    expect(container.textContent).not.toContain('outstanding')
  })

  it('shows the outstanding balance when partially paid (compact)', () => {
    const item = { cost: '€100', details: { amount_paid: '€60' } }
    const { container } = render(<CostDisplay item={item} compact />)
    expect(container.textContent).toContain('outstanding')
    expect(container.textContent).toContain('€40')
  })

  it('renders a Total / Paid / Outstanding breakdown in full mode', () => {
    const item = { cost: '€100', details: { amount_paid: '€60' } }
    const { container } = render(<CostDisplay item={item} />)
    expect(container.textContent).toContain('Total')
    expect(container.textContent).toContain('Paid')
    expect(container.textContent).toContain('Outstanding')
  })
})
