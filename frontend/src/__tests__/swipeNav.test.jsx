import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useSwipeNav } from '../swipeNav.js'

function Harness({ itemId }) {
  useSwipeNav(itemId)
  return null
}

function touch(type, x, y) {
  const ev = new Event(type, { bubbles: true })
  const point = { clientX: x, clientY: y }
  ev.touches = type === 'touchend' ? [] : [point]
  ev.changedTouches = [point]
  document.dispatchEvent(ev)
}

let events
let handler
beforeEach(() => {
  events = []
  handler = e => events.push(e.detail)
  window.addEventListener('modalNav', handler)
})
afterEach(() => {
  window.removeEventListener('modalNav', handler)
  cleanup()
})

describe('useSwipeNav', () => {
  it('swipe left dispatches next', () => {
    render(<Harness itemId={7} />)
    touch('touchstart', 240, 100)
    touch('touchend', 140, 110)       // dx -100, dy 10
    expect(events).toEqual([{ itemId: 7, direction: 'next' }])
  })

  it('swipe right dispatches prev', () => {
    render(<Harness itemId={7} />)
    touch('touchstart', 100, 100)
    touch('touchend', 220, 95)        // dx +120
    expect(events).toEqual([{ itemId: 7, direction: 'prev' }])
  })

  it('ignores mostly-vertical gestures (scrolling)', () => {
    render(<Harness itemId={7} />)
    touch('touchstart', 100, 100)
    touch('touchend', 130, 300)       // dx 30, dy 200
    expect(events).toEqual([])
  })

  it('ignores short taps', () => {
    render(<Harness itemId={7} />)
    touch('touchstart', 100, 100)
    touch('touchend', 120, 100)       // dx 20 < threshold
    expect(events).toEqual([])
  })
})
