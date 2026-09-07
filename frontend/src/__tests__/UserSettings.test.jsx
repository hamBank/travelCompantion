import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import UserSettings from '../components/UserSettings.jsx'
import * as api from '../api.js'
import { getDefaultToToday } from '../settings.js'

vi.mock('../api.js')

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  api.getImportAddress.mockResolvedValue({ address: 'import+x@example.com' })
  api.listDocuments.mockResolvedValue([])
  api.getApiTokens.mockResolvedValue([])
})

describe('UserSettings', () => {
  it('renders the Notifications section without crashing', async () => {
    render(<UserSettings onClose={() => {}} />)
    expect(await screen.findByText('Notifications')).toBeTruthy()
    // jsdom has no PushManager/serviceWorker → reported unsupported, not crashed
    expect(screen.getByText(/Not supported/i)).toBeTruthy()
  })
})

describe('Default-to-Today toggle', () => {
  it('persists the preference on Save', async () => {
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('import+x@example.com')
    expect(getDefaultToToday()).toBe(false)

    fireEvent.click(screen.getByText('Open trips in Today view by default'))
    fireEvent.click(screen.getByText('Save'))

    expect(getDefaultToToday()).toBe(true)
  })
})

describe('ImportAddress regenerate', () => {
  it('asks for confirmation before rotating, and cancel backs out without calling the API', async () => {
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('import+x@example.com')

    fireEvent.click(screen.getByText('Regenerate address'))
    expect(await screen.findByText(/stops working immediately/)).toBeTruthy()

    fireEvent.click(screen.getByText('Never mind'))
    expect(screen.queryByText(/stops working immediately/)).toBeNull()
    expect(api.regenerateImportAddress).not.toHaveBeenCalled()
  })

  it('confirming rotates the address and displays the new one', async () => {
    api.regenerateImportAddress.mockResolvedValue({ address: 'import+y@example.com' })
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('import+x@example.com')

    fireEvent.click(screen.getByText('Regenerate address'))
    fireEvent.click(await screen.findByText('Confirm'))

    await waitFor(() => expect(api.regenerateImportAddress).toHaveBeenCalled())
    expect(await screen.findByText('import+y@example.com')).toBeTruthy()
    expect(screen.queryByText('import+x@example.com')).toBeNull()
  })

  it('shows an error message if rotation fails, without losing the old address', async () => {
    api.regenerateImportAddress.mockRejectedValue(new Error('Server error'))
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('import+x@example.com')

    fireEvent.click(screen.getByText('Regenerate address'))
    fireEvent.click(await screen.findByText('Confirm'))

    expect(await screen.findByText('Server error')).toBeTruthy()
    expect(screen.getByText('import+x@example.com')).toBeTruthy()
  })
})

describe('API access tokens', () => {
  it('lists existing tokens with their expiry, and hides Revoke for an already-revoked one', async () => {
    api.getApiTokens.mockResolvedValue([
      { id: 1, label: 'cli', created_at: '2026-01-01T00:00:00', expires_at: '2027-01-01T00:00:00', revoked_at: null },
      { id: 2, label: '', created_at: '2026-01-02T00:00:00', expires_at: '2027-01-02T00:00:00', revoked_at: '2026-06-01T00:00:00' },
    ])
    render(<UserSettings onClose={() => {}} />)

    expect(await screen.findByText('cli')).toBeTruthy()
    expect(screen.getByText('Unlabeled token')).toBeTruthy()
    expect(screen.getByText('Revoked')).toBeTruthy()
    // Only the active token gets a Revoke button.
    expect(screen.getAllByText('Revoke')).toHaveLength(1)
  })

  it('creates a token, shows the secret once with a copy button, and refreshes the list', async () => {
    api.createApiToken.mockResolvedValue({ id: 3, token: 'secret-abc', label: 'agent', email: 'me@example.com' })
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('import+x@example.com')

    fireEvent.change(screen.getByPlaceholderText('Label (optional)'), { target: { value: 'agent' } })
    api.getApiTokens.mockResolvedValue([
      { id: 3, label: 'agent', created_at: '2026-01-01T00:00:00', expires_at: '2027-01-01T00:00:00', revoked_at: null },
    ])
    fireEvent.click(screen.getByText('Create token'))

    expect(await screen.findByText('secret-abc')).toBeTruthy()
    expect(api.createApiToken).toHaveBeenCalledWith({ label: 'agent' })
    // The list re-fetch picks up the newly created token.
    expect(await screen.findByText('agent')).toBeTruthy()
  })

  it('revokes a token and removes its Revoke button once the list refreshes', async () => {
    api.getApiTokens.mockResolvedValueOnce([
      { id: 1, label: 'cli', created_at: '2026-01-01T00:00:00', expires_at: '2027-01-01T00:00:00', revoked_at: null },
    ])
    api.revokeApiToken.mockResolvedValue(null)
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('cli')

    api.getApiTokens.mockResolvedValue([
      { id: 1, label: 'cli', created_at: '2026-01-01T00:00:00', expires_at: '2027-01-01T00:00:00', revoked_at: '2026-06-01T00:00:00' },
    ])
    fireEvent.click(screen.getByText('Revoke'))

    await waitFor(() => expect(api.revokeApiToken).toHaveBeenCalledWith(1))
    expect(await screen.findByText('Revoked')).toBeTruthy()
    expect(screen.queryByText('Revoke')).toBeNull()
  })

  it('shows an error message if creating a token fails', async () => {
    api.createApiToken.mockRejectedValue(new Error('Server error'))
    render(<UserSettings onClose={() => {}} />)
    await screen.findByText('import+x@example.com')

    fireEvent.click(screen.getByText('Create token'))
    expect(await screen.findByText('Server error')).toBeTruthy()
  })
})
