import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  updateStopStatus: vi.fn(), updateItemStatus: vi.fn(), getWeather: vi.fn(),
  fetchRiverMapBlob: vi.fn(), fetchGpxMapBlob: vi.fn(), fetchDayMapBlob: vi.fn(),
  fetchGpxText: vi.fn().mockResolvedValue(null),
  downloadGpx: vi.fn(),
  listAttachments: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(), deleteAttachment: vi.fn(), fetchAttachmentBlob: vi.fn(),
  deleteItem: vi.fn(),
  updateItem: vi.fn(), updateStop: vi.fn(), updatePackItem: vi.fn(),
}))

import StopCard from '../components/StopCard.jsx'

const STOP = { id: 9, location: 'Florence', status: 'planned', items: [] }

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue() } })
})

describe('StopCard — copy link', () => {
  it('copies /t/:tripId/stop/:stopId to the clipboard, without toggling the stop open/closed', () => {
    render(<StopCard stop={STOP} index={0} tripId={42} />)
    fireEvent.click(screen.getByTitle('Copy link to this stop'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/t/42/stop/9'))
  })

  it('is not shown at all when no tripId is passed (e.g. a standalone/test caller)', () => {
    render(<StopCard stop={STOP} index={0} />)
    expect(screen.queryByTitle('Copy link to this stop')).toBeNull()
  })
})
