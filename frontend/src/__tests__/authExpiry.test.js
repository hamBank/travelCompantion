import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getTrips, loginWithGoogle, AUTH_EXPIRED_EVENT,
  fetchAttachmentBlob, uploadAttachment, downloadGpx, exportTripPdf, parseDocument,
} from '../api.js'

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

  it('does NOT sign out a newer session when a stale request 401s (response lands late)', async () => {
    // A request sent with the old token is in flight; the user signs in again
    // (new token stored); the old request then comes back 401. That 401 is
    // about the old token, so it must not log out the fresh session.
    localStorage.setItem('tc-token', 'old-jwt')
    global.fetch = vi.fn().mockImplementation(async () => {
      localStorage.setItem('tc-token', 'new-jwt')
      return {
        ok: false, status: 401, statusText: 'Unauthorized',
        text: async () => JSON.stringify({ detail: 'Invalid or expired token' }),
      }
    })
    await expect(getTrips()).rejects.toThrow('Invalid or expired token')
    expect(dispatched).toHaveLength(0)
  })

  it('does NOT dispatch when the user already signed out before the 401 lands', async () => {
    localStorage.setItem('tc-token', 'old-jwt')
    global.fetch = vi.fn().mockImplementation(async () => {
      localStorage.removeItem('tc-token')
      return {
        ok: false, status: 401, statusText: 'Unauthorized',
        text: async () => JSON.stringify({ detail: 'Invalid or expired token' }),
      }
    })
    await expect(getTrips()).rejects.toThrow()
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

function okResponse(body, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    json: async () => body,
    blob: async () => new Blob(['x']),
  }
}

describe('sliding session: X-Refreshed-Token', () => {
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('stores the fresh token the backend hands back', async () => {
    localStorage.setItem('tc-token', 'aging-jwt')
    global.fetch = vi.fn().mockResolvedValue(okResponse([], { 'X-Refreshed-Token': 'brand-new-jwt' }))
    await getTrips()
    expect(localStorage.getItem('tc-token')).toBe('brand-new-jwt')
  })

  it('uses the new token on the next request', async () => {
    localStorage.setItem('tc-token', 'aging-jwt')
    global.fetch = vi.fn()
      .mockResolvedValueOnce(okResponse([], { 'X-Refreshed-Token': 'brand-new-jwt' }))
      .mockResolvedValueOnce(okResponse([]))
    await getTrips()
    await getTrips()
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer brand-new-jwt')
  })

  it('leaves the stored token alone when no header comes back', async () => {
    localStorage.setItem('tc-token', 'fresh-jwt')
    global.fetch = vi.fn().mockResolvedValue(okResponse([]))
    await getTrips()
    expect(localStorage.getItem('tc-token')).toBe('fresh-jwt')
  })

  it('does not write a token back after sign-out (response lands late)', async () => {
    localStorage.setItem('tc-token', 'aging-jwt')
    global.fetch = vi.fn().mockImplementation(async () => {
      localStorage.removeItem('tc-token') // user signs out while the request is in flight
      return okResponse([], { 'X-Refreshed-Token': 'brand-new-jwt' })
    })
    await getTrips()
    expect(localStorage.getItem('tc-token')).toBeNull()
  })

  it('does not overwrite a different session that signed in meanwhile', async () => {
    localStorage.setItem('tc-token', 'aging-jwt')
    global.fetch = vi.fn().mockImplementation(async () => {
      localStorage.setItem('tc-token', 'someone-elses-jwt')
      return okResponse([], { 'X-Refreshed-Token': 'brand-new-jwt' })
    })
    await getTrips()
    expect(localStorage.getItem('tc-token')).toBe('someone-elses-jwt')
  })

  it('stores a refreshed token from a download/blob helper too', async () => {
    localStorage.setItem('tc-token', 'aging-jwt')
    global.fetch = vi.fn().mockResolvedValue(okResponse({}, { 'X-Refreshed-Token': 'brand-new-jwt' }))
    await fetchAttachmentBlob(1)
    expect(localStorage.getItem('tc-token')).toBe('brand-new-jwt')
  })
})

describe('expired-session handling in the direct-fetch helpers', () => {
  let dispatched
  let listener

  beforeEach(() => {
    dispatched = []
    listener = e => dispatched.push(e)
    window.addEventListener(AUTH_EXPIRED_EVENT, listener)
    localStorage.setItem('tc-token', 'expired-jwt')
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
      text: async () => JSON.stringify({ detail: 'Invalid or expired token' }),
      json: async () => ({ detail: 'Invalid or expired token' }),
    })
  })

  afterEach(() => {
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener)
    localStorage.clear()
    vi.restoreAllMocks()
  })

  const file = () => new File(['x'], 'x.txt')

  it.each([
    ['fetchAttachmentBlob', () => fetchAttachmentBlob(1)],
    ['uploadAttachment', () => uploadAttachment(1, file())],
    ['downloadGpx', () => downloadGpx(1, 'a.gpx')],
    ['exportTripPdf', () => exportTripPdf(1, 'Trip')],
    ['parseDocument', () => parseDocument(1, [file()])],
  ])('%s announces the expiry on a 401', async (_name, call) => {
    await call().catch(() => {})
    expect(dispatched).toHaveLength(1)
  })

  it('the blob helpers still send the bearer token', async () => {
    await fetchAttachmentBlob(1)
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer expired-jwt')
  })
})
