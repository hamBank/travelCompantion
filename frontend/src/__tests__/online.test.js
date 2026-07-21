import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOnline } from '../online.js'

describe('useOnline', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  })

  it('reflects navigator.onLine at mount', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    const { result } = renderHook(() => useOnline())
    expect(result.current).toBe(false)
  })

  it('updates when the browser fires offline/online events', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    const { result } = renderHook(() => useOnline())
    expect(result.current).toBe(true)

    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(result.current).toBe(false)

    act(() => { window.dispatchEvent(new Event('online')) })
    expect(result.current).toBe(true)
  })
})

// ── Server-down (deploy/restart) handling ───────────────────────────────────
import { vi } from 'vitest'
import { markServerDown, isServerDown, resetServerDownForTests, SERVER_UP_EVENT } from '../online.js'

describe('markServerDown / recovery poll', () => {
  afterEach(() => {
    resetServerDownForTests()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('flips useOnline false immediately, without a browser offline event', () => {
    vi.useFakeTimers()
    global.fetch = vi.fn().mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useOnline())
    expect(result.current).toBe(true)
    act(() => { markServerDown() })
    expect(result.current).toBe(false)
    expect(isServerDown()).toBe(true)
  })

  it('polls /health and flips back online (announcing recovery) once it responds', async () => {
    vi.useFakeTimers()
    // First poll: still down. Second poll: recovered.
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 })
    const upEvents = []
    window.addEventListener(SERVER_UP_EVENT, e => upEvents.push(e))

    const { result } = renderHook(() => useOnline())
    act(() => { markServerDown() })
    expect(result.current).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    expect(result.current).toBe(false)  // first poll still 503

    await act(async () => { await vi.advanceTimersByTimeAsync(5100) })
    expect(result.current).toBe(true)
    expect(isServerDown()).toBe(false)
    expect(upEvents).toHaveLength(1)
    expect(global.fetch).toHaveBeenCalledWith('/health', { cache: 'no-store' })
  })

  it('keeps polling through network errors while the server restarts', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))
    act(() => { markServerDown() })
    await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
    expect(isServerDown()).toBe(true)
    expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})
