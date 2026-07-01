import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
