import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  urlBase64ToUint8Array, isPushSupported, getPushEnabled,
  enablePush, disablePush,
} from '../push.js'
import * as api from '../api.js'

vi.mock('../api.js')

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url VAPID-style key to the expected byte length', () => {
    // 87-char base64url (no padding) → 65 raw bytes (uncompressed EC point)
    const key = 'A'.repeat(86) + 'B'
    const bytes = urlBase64ToUint8Array(key)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(65)
  })

  it('round-trips a known string', () => {
    // "hello" base64url-encoded without padding
    const b64 = btoa('hello').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const bytes = urlBase64ToUint8Array(b64)
    const decoded = String.fromCharCode(...bytes)
    expect(decoded).toBe('hello')
  })
})

describe('getPushEnabled / device-local toggle', () => {
  beforeEach(() => localStorage.clear())
  it('defaults to false', () => expect(getPushEnabled()).toBe(false))
})

describe('isPushSupported', () => {
  it('reflects presence of serviceWorker + PushManager on the global objects', () => {
    // jsdom doesn't provide these by default
    expect(isPushSupported()).toBe(false)
  })
})

describe('enablePush / disablePush', () => {
  let subscription, registration

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()

    subscription = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'P', auth: 'A' } }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    }
    registration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(subscription),
      },
    }

    global.navigator.serviceWorker = { ready: Promise.resolve(registration) }
    global.window.PushManager = function () {}
    global.Notification = { requestPermission: vi.fn().mockResolvedValue('granted') }

    api.getVapidPublicKey.mockResolvedValue({ key: 'A'.repeat(86) + 'B' })
    api.subscribePush.mockResolvedValue({ ok: true })
    api.unsubscribePush.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    delete global.navigator.serviceWorker
    delete global.window.PushManager
    delete global.Notification
  })

  it('enablePush subscribes and posts the subscription, then marks enabled', async () => {
    await enablePush()
    expect(registration.pushManager.subscribe).toHaveBeenCalled()
    expect(api.subscribePush).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://push.example/abc', p256dh: 'P', auth: 'A',
    }))
    expect(getPushEnabled()).toBe(true)
  })

  it('enablePush throws if permission is denied, and does not mark enabled', async () => {
    global.Notification.requestPermission.mockResolvedValue('denied')
    await expect(enablePush()).rejects.toThrow(/permission/i)
    expect(getPushEnabled()).toBe(false)
  })

  it('disablePush unsubscribes and clears the enabled flag', async () => {
    registration.pushManager.getSubscription.mockResolvedValue(subscription)
    localStorage.setItem('tc-push-enabled', '1')

    await disablePush()

    expect(api.unsubscribePush).toHaveBeenCalledWith('https://push.example/abc')
    expect(subscription.unsubscribe).toHaveBeenCalled()
    expect(getPushEnabled()).toBe(false)
  })
})
