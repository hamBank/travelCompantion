import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import UserSettings from '../components/UserSettings.jsx'
import * as api from '../api.js'

vi.mock('../api.js')

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  api.getImportAddress.mockResolvedValue({ address: 'import+x@example.com' })
})

describe('UserSettings', () => {
  it('renders the Notifications section without crashing', async () => {
    render(<UserSettings onClose={() => {}} />)
    expect(await screen.findByText('Notifications')).toBeTruthy()
    // jsdom has no PushManager/serviceWorker → reported unsupported, not crashed
    expect(screen.getByText(/Not supported/i)).toBeTruthy()
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
