import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import EditStopCard from '../components/EditStopCard.jsx'
import * as api from '../api.js'

const STOP = {
  id: 10, location: 'Tokyo', country: 'Japan', arrive: null, depart: null,
  timezone: '0', lat: '', lng: '', status: 'planned', priority: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(api, 'updateStop').mockResolvedValue({ ...STOP })
  vi.spyOn(api, 'deleteStop').mockResolvedValue(null)
})

function openCard() {
  render(<EditStopCard stop={STOP} index={0} onRefresh={() => {}} />)
  fireEvent.click(screen.getByText('Tokyo'))
}

describe('EditStopCard priority field', () => {
  it('renders empty by default when the stop is unranked', () => {
    openCard()
    expect(screen.getByLabelText('Priority')).toHaveValue(null)
  })

  it('pre-fills the current priority', () => {
    render(<EditStopCard stop={{ ...STOP, priority: 2 }} index={0} onRefresh={() => {}} />)
    fireEvent.click(screen.getByText('Tokyo'))
    expect(screen.getByLabelText('Priority')).toHaveValue(2)
  })

  it('shows a colour swatch once a priority is entered, not before', () => {
    openCard()
    expect(screen.queryByTitle(/colour$/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '1' } })
    expect(screen.getByTitle('Priority 1 colour')).toBeInTheDocument()
  })

  it('saves priority as an integer', async () => {
    openCard()
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('Save stop'))
    await waitFor(() => {
      expect(api.updateStop).toHaveBeenCalledWith(10, expect.objectContaining({ priority: 1 }))
    })
  })

  it('saves priority as null when cleared', async () => {
    render(<EditStopCard stop={{ ...STOP, priority: 3 }} index={0} onRefresh={() => {}} />)
    fireEvent.click(screen.getByText('Tokyo'))
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Save stop'))
    await waitFor(() => {
      expect(api.updateStop).toHaveBeenCalledWith(10, expect.objectContaining({ priority: null }))
    })
  })
})
