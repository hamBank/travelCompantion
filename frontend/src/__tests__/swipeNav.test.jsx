import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useSwipeNav } from '../swipeNav.js'

function Harness({ onDirection, enabled }) {
  useSwipeNav(onDirection, enabled)
  return null
}

function touch(type, x, y) {
  const ev = new Event(type, { bubbles: true })
  const point = { clientX: x, clientY: y }
  ev.touches = type === 'touchend' ? [] : [point]
  ev.changedTouches = [point]
  document.dispatchEvent(ev)
}

afterEach(() => cleanup())

describe('useSwipeNav', () => {
  it('swipe left calls onDirection with next', () => {
    const onDirection = vi.fn()
    render(<Harness onDirection={onDirection} />)
    touch('touchstart', 240, 100)
    touch('touchend', 140, 110)       // dx -100, dy 10
    expect(onDirection).toHaveBeenCalledWith('next')
  })

  it('swipe right calls onDirection with prev', () => {
    const onDirection = vi.fn()
    render(<Harness onDirection={onDirection} />)
    touch('touchstart', 100, 100)
    touch('touchend', 220, 95)        // dx +120
    expect(onDirection).toHaveBeenCalledWith('prev')
  })

  it('ignores mostly-vertical gestures (scrolling)', () => {
    const onDirection = vi.fn()
    render(<Harness onDirection={onDirection} />)
    touch('touchstart', 100, 100)
    touch('touchend', 130, 300)       // dx 30, dy 200
    expect(onDirection).not.toHaveBeenCalled()
  })

  it('ignores short taps', () => {
    const onDirection = vi.fn()
    render(<Harness onDirection={onDirection} />)
    touch('touchstart', 100, 100)
    touch('touchend', 120, 100)       // dx 20 < threshold
    expect(onDirection).not.toHaveBeenCalled()
  })

  it('does not attach listeners when disabled', () => {
    const onDirection = vi.fn()
    render(<Harness onDirection={onDirection} enabled={false} />)
    touch('touchstart', 240, 100)
    touch('touchend', 140, 110)
    expect(onDirection).not.toHaveBeenCalled()
  })
})
