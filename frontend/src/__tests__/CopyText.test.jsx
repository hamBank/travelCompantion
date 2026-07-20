import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import CopyText from '../components/CopyText.jsx'

describe('CopyText', () => {
  let writeText

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue()
    Object.assign(navigator, { clipboard: { writeText } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('copies the value on click and flashes confirmation', async () => {
    render(<CopyText value="DYL7CY" />)
    fireEvent.click(screen.getByText('DYL7CY'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('DYL7CY'))
    await screen.findByText('✓ Copied')
  })

  it('copies the value prop even when rendering different children', async () => {
    render(<CopyText value="REF123"><span>⧉</span></CopyText>)
    fireEvent.click(screen.getByText('⧉'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('REF123'))
  })

  it('clears the confirmation after a moment', async () => {
    vi.useFakeTimers()
    render(<CopyText value="DYL7CY" />)
    fireEvent.click(screen.getByText('DYL7CY'))
    // Let the async clipboard promise resolve, then run the visibility timer out.
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('✓ Copied')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.queryByText('✓ Copied')).toBeNull()
  })

  it('shows no confirmation when the clipboard write fails', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    render(<CopyText value="DYL7CY" />)
    fireEvent.click(screen.getByText('DYL7CY'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('✓ Copied')).toBeNull()
  })
})
