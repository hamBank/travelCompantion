import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PassengersTable from '../components/PassengersTable.jsx'

describe('PassengersTable', () => {
  it('renders the seat as a seatmap link with an armchair icon when a seatmapUrl is given', () => {
    const { container } = render(
      <PassengersTable
        passengers={[{ name: 'A Traveller', seat: '14C' }]}
        seatmapUrl="https://aerolopa.com/QF"
      />
    )
    const link = screen.getByText('14C').closest('a')
    expect(link).toHaveAttribute('href', 'https://aerolopa.com/QF')
    expect(container.querySelector('svg.lucide-armchair')).toBeTruthy()
  })

  it('keeps the SEAT label glued to its value so it cannot wrap onto its own line', () => {
    const { container } = render(
      <PassengersTable
        passengers={[{ name: 'A Traveller', seat: '14C' }]}
        seatmapUrl="https://aerolopa.com/QF"
      />
    )
    const seatSpan = screen.getByText('Seat').closest('span.whitespace-nowrap')
    expect(seatSpan).toHaveClass('whitespace-nowrap')
    expect(seatSpan.textContent).toContain('14C')
  })

  it('renders the seat as plain text (no link, no icon) when there is no seatmapUrl', () => {
    const { container } = render(
      <PassengersTable passengers={[{ name: 'A Traveller', seat: '14C' }]} />
    )
    expect(screen.getByText('14C').closest('a')).toBeNull()
    expect(container.querySelector('svg.lucide-armchair')).toBeNull()
  })

  it('does not render a Seat row at all when no seat is assigned', () => {
    render(
      <PassengersTable
        passengers={[{ name: 'A Traveller', ticket: 'XYZ' }]}
        seatmapUrl="https://aerolopa.com/QF"
      />
    )
    expect(screen.queryByText('Seat')).not.toBeInTheDocument()
  })
})
