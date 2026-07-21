import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PowerbankDetailModal from '../components/PowerbankDetailModal.jsx'

describe('PowerbankDetailModal', () => {
  it('renders the full policy detail for the given airline', () => {
    render(<PowerbankDetailModal airline="Singapore Airlines" onClose={() => {}} />)
    expect(screen.getByText('Singapore Airlines')).toBeInTheDocument()
    expect(screen.getByText('Max capacity')).toBeInTheDocument()
    expect(screen.getByText('Storage')).toBeInTheDocument()
    expect(screen.getByText(/Must be kept in the seat pocket/)).toBeInTheDocument()
  })

  it('falls back to the ICAO default when the airline is unmatched', () => {
    render(<PowerbankDetailModal airline="Some Unknown Air" onClose={() => {}} />)
    expect(screen.getByText(/ICAO/)).toBeInTheDocument()
  })

  it('closes on backdrop click and the close button', () => {
    const onClose = vi.fn()
    const { container } = render(<PowerbankDetailModal airline="Qantas" onClose={onClose} />)
    fireEvent.click(container.firstChild)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<PowerbankDetailModal airline="Qantas" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
