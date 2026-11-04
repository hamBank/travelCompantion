import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { forwardRef } from 'react'

/**
 * A returning user whose token expired while the app was closed fires authed
 * requests the moment it boots, and their 401s can land before /auth/config
 * has answered. The sign-out listener must already be attached by then, or
 * the event is lost and the user is left in an app where every request fails.
 */

vi.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }) => children,
}))

const { getAuthConfig } = vi.hoisted(() => ({ getAuthConfig: vi.fn() }))

vi.mock('../api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAuthConfig,
    getTrips: vi.fn().mockResolvedValue([]),
    getPending: vi.fn().mockResolvedValue([]),
    exportTripPdf: vi.fn(),
  }
})

vi.mock('../components/LoginPage.jsx', () => ({
  default: () => <div data-testid="login-page" />,
}))
vi.mock('../components/TripTimeline.jsx', () => ({
  default: forwardRef(() => <div data-testid="timeline" />),
}))
vi.mock('../offlineQueue.js', () => ({
  offlineQueue: { enqueue: vi.fn(), count: vi.fn().mockResolvedValue(0), conflicts: vi.fn().mockResolvedValue([]) },
  useOfflineQueue: () => ({ pendingCount: 0, conflicts: [], resolve: vi.fn() }),
}))

import { AUTH_EXPIRED_EVENT } from '../api.js'
import App from '../App.jsx'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  localStorage.setItem('tc-token', 'expired-jwt')
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  localStorage.clear()
})

describe('401 during boot, before /auth/config answers', () => {
  it('still signs the user out and shows the login page once config arrives', async () => {
    let resolveConfig
    getAuthConfig.mockReturnValue(new Promise(resolve => { resolveConfig = resolve }))

    render(<App />)
    act(() => { window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)) })
    expect(localStorage.getItem('tc-token')).toBeNull()

    await act(async () => { resolveConfig({ enabled: true, client_id: 'cid' }) })
    await waitFor(() => expect(screen.getByTestId('login-page')).toBeInTheDocument())
  })

  it('a 401 after config has loaded signs out too', async () => {
    getAuthConfig.mockResolvedValue({ enabled: true, client_id: 'cid' })
    render(<App />)
    await waitFor(() => expect(getAuthConfig).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 20))

    act(() => { window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT)) })
    await waitFor(() => expect(screen.getByTestId('login-page')).toBeInTheDocument())
    expect(localStorage.getItem('tc-token')).toBeNull()
  })
})
