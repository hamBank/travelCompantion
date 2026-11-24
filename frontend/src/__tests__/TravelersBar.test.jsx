import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TravelersBar from '../components/TravelersBar.jsx'
import * as api from '../api.js'

vi.mock('../api.js')

beforeEach(() => vi.resetAllMocks())

describe('TravelersBar', () => {
  it('names who is travelling', async () => {
    api.getTravelers.mockResolvedValue([{ display_name: 'Dev' }, { display_name: 'Mia' }])
    render(<TravelersBar tripId={1} onOpen={() => {}} />)
    expect(await screen.findByText('Dev, Mia')).toBeTruthy()
  })

  it('abbreviates a long list', async () => {
    api.getTravelers.mockResolvedValue(['A', 'B', 'C', 'D', 'E'].map(n => ({ display_name: n })))
    render(<TravelersBar tripId={1} onOpen={() => {}} />)
    expect(await screen.findByText('A, B, C +2')).toBeTruthy()
  })

  it('flags an empty list and opens the Travelers screen on click', async () => {
    api.getTravelers.mockResolvedValue([])
    const onOpen = vi.fn()
    render(<TravelersBar tripId={1} onOpen={onOpen} />)
    fireEvent.click(await screen.findByText(/No travelers added yet/))
    expect(onOpen).toHaveBeenCalled()
  })

  it('renders nothing while loading or if the fetch fails', async () => {
    api.getTravelers.mockRejectedValue(new Error('nope'))
    const { container } = render(<TravelersBar tripId={1} onOpen={() => {}} />)
    await Promise.resolve()
    expect(container.textContent).toBe('')
  })
})
