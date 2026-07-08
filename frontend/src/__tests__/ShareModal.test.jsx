import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../api.js', () => ({
  getTripMembers: vi.fn(),
  addTripMember: vi.fn(),
  removeTripMember: vi.fn(),
  getCalendarUrl: vi.fn(),
  getShareToken: vi.fn(),
  createShareToken: vi.fn(),
  revokeShareToken: vi.fn(),
}))
import {
  getTripMembers, getShareToken, createShareToken, revokeShareToken,
} from '../api.js'
import ShareModal from '../components/ShareModal.jsx'

const trip = { id: 1, name: 'Family Trip' }

beforeEach(() => {
  vi.clearAllMocks()
  getTripMembers.mockResolvedValue([])
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue() } })
})

describe('ShareModal — public link', () => {
  it('shows a "Create public link" button when no link exists yet', async () => {
    getShareToken.mockResolvedValue({ token: null, url: null })
    render(<ShareModal trip={trip} onClose={() => {}} />)
    expect(await screen.findByText('Create public link')).toBeInTheDocument()
  })

  it('shows the existing link (with copy/regenerate/revoke) when one is already set', async () => {
    getShareToken.mockResolvedValue({ token: 'abc123', url: '/shared/abc123' })
    render(<ShareModal trip={trip} onClose={() => {}} />)
    expect(await screen.findByText(/\/shared\/abc123/)).toBeInTheDocument()
    expect(screen.getByText('Copy link')).toBeInTheDocument()
    expect(screen.getByText('Regenerate')).toBeInTheDocument()
    expect(screen.getByText('Revoke')).toBeInTheDocument()
  })

  it('creates a link and copies it to the clipboard', async () => {
    getShareToken.mockResolvedValue({ token: null, url: null })
    createShareToken.mockResolvedValue({ token: 'freshtoken', url: '/shared/freshtoken' })
    render(<ShareModal trip={trip} onClose={() => {}} />)

    fireEvent.click(await screen.findByText('Create public link'))
    await waitFor(() => expect(createShareToken).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.getByText(/\/shared\/freshtoken/)).toBeInTheDocument())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/shared/freshtoken'))
  })

  it('revokes the link, reverting to the "Create public link" state', async () => {
    getShareToken.mockResolvedValue({ token: 'abc123', url: '/shared/abc123' })
    revokeShareToken.mockResolvedValue(null)
    render(<ShareModal trip={trip} onClose={() => {}} />)

    fireEvent.click(await screen.findByText('Revoke'))
    await waitFor(() => expect(revokeShareToken).toHaveBeenCalledWith(1))
    await waitFor(() => expect(screen.getByText('Create public link')).toBeInTheDocument())
  })
})
