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
