import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getTrips, loginWithGoogle, AUTH_EXPIRED_EVENT } from '../api.js'

/**
 * An expired JWT means every authed request 401s. api.js must announce that
 * (AUTH_EXPIRED_EVENT) so AuthenticatedApp can sign the user out and show the
 * login page — the pre-fix behavior was a broken app (every fetch erroring)
 * until the user found Sign out themselves.
 */

function mock401() {
  global.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ detail: 'Invalid or expired token' }),
  })
}

describe('expired-session handling in api.req', () => {
  let dispatched

  beforeEach(() => {
    dispatched = []
    window.addEventListener(AUTH_EXPIRED_EVENT, e => dispatched.push(e))
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('dispatches AUTH_EXPIRED_EVENT on a 401 when a token was sent', async () => {
    localStorage.setItem('tc-token', 'expired-jwt')
    mock401()
    await expect(getTrips()).rejects.toThrow('Invalid or expired token')
    expect(dispatched).toHaveLength(1)
  })

  it('does NOT dispatch on a 401 with no stored token (e.g. a failed login attempt)', async () => {
    localStorage.removeItem('tc-token')
    mock401()
    await expect(loginWithGoogle('bad-credential')).rejects.toThrow()
    expect(dispatched).toHaveLength(0)
  })

  it('does NOT dispatch on non-401 errors even with a token', async () => {
    localStorage.setItem('tc-token', 'valid-jwt')
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ detail: 'boom' }),
    })
    await expect(getTrips()).rejects.toThrow('boom')
    expect(dispatched).toHaveLength(0)
  })
})
