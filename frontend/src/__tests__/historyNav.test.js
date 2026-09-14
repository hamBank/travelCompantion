import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SNAPSHOT_VERSION, rootSnapshot, pushNav, replaceNav, back, currentNav,
  onPopNav, registerNavGuard, layerDepth,
} from '../historyNav.js'

// Plan-18a's historyNav.js has no React — it's just history.pushState/
// replaceState/popstate plumbing, so it's tested directly against jsdom's
// real `history` and `popstate` rather than through any component.
//
// Popped navigation is simulated by dispatching a real PopStateEvent
// (handlePopState reads event.state, not history.state, so this doesn't
// need to keep the two in sync) — jsdom's actual history.back()/go() fire
// popstate asynchronously (confirmed empirically: not even a single
// setTimeout(0) tick is enough), which would make these tests slow and
// timing-dependent for no benefit.

function snap(overrides = {}) {
  return { ...rootSnapshot(), tripId: 1, ...overrides }
}

function dispatchPop(state) {
  window.dispatchEvent(new PopStateEvent('popstate', { state }))
}

beforeEach(() => {
  // Reset the entry under the test to a "foreign" one (no v:1 state) so
  // isSameNav/currentNav start from a known baseline each test, and clear
  // any go() spy from a previous test.
  window.history.replaceState(null, '')
  vi.restoreAllMocks()
})

describe('pushNav / replaceNav / currentNav', () => {
  it('push writes a v:1 state', () => {
    pushNav(snap({ mode: 'packing' }))
    expect(currentNav()).toEqual(snap({ mode: 'packing', v: SNAPSHOT_VERSION }))
  })

  it('replace writes a v:1 state without adding an entry', () => {
    const lengthBefore = window.history.length
    replaceNav(snap({ mode: 'today' }))
    expect(currentNav()).toEqual(snap({ mode: 'today', v: SNAPSHOT_VERSION }))
    expect(window.history.length).toBe(lengthBefore)
  })

  it('an identical consecutive push is a no-op', () => {
    pushNav(snap())
    const lengthAfterFirst = window.history.length
    pushNav(snap()) // same fields — e.g. an effect firing twice
    expect(window.history.length).toBe(lengthAfterFirst)
  })

  it('an identical consecutive replace is a no-op', () => {
    replaceNav(snap())
    const stateBefore = currentNav()
    replaceNav(snap())
    expect(currentNav()).toEqual(stateBefore)
  })

  it('currentNav() returns null for a foreign entry', () => {
    window.history.replaceState({ some: 'other app state' }, '')
    expect(currentNav()).toBeNull()
  })

  it('currentNav() returns null with no state at all', () => {
    window.history.replaceState(null, '')
    expect(currentNav()).toBeNull()
  })
})

describe('back()', () => {
  it('delegates to history.back()', () => {
    const spy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    back()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('onPopNav', () => {
  it('delivers the popped entry\'s state', () => {
    const handler = vi.fn()
    const unsubscribe = onPopNav(handler)
    dispatchPop(snap({ mode: 'edit' }))
    expect(handler).toHaveBeenCalledWith(snap({ mode: 'edit' }))
    unsubscribe()
  })

  it('delivers null for a foreign entry', () => {
    const handler = vi.fn()
    const unsubscribe = onPopNav(handler)
    dispatchPop({ some: 'pre-app history entry' })
    expect(handler).toHaveBeenCalledWith(null)
    unsubscribe()
  })

  it('delivers null when the entry has no state at all', () => {
    const handler = vi.fn()
    const unsubscribe = onPopNav(handler)
    dispatchPop(null)
    expect(handler).toHaveBeenCalledWith(null)
    unsubscribe()
  })

  it('unsubscribe stops delivery', () => {
    const handler = vi.fn()
    const unsubscribe = onPopNav(handler)
    unsubscribe()
    dispatchPop(snap())
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('registerNavGuard', () => {
  it('a guard returning false aborts: the handler is not called, and history.go(1) undoes the pop', () => {
    const goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {})
    const handler = vi.fn()
    const unsubscribeHandler = onPopNav(handler)
    const guard = vi.fn(() => false)
    const unregister = registerNavGuard(guard)

    dispatchPop(snap({ mode: 'edit' }))

    expect(guard).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
    expect(goSpy).toHaveBeenCalledWith(1)

    // history.go(1) itself fires its own popstate later (undoing the pop) —
    // the module must swallow that echo rather than re-running guards or
    // notifying subscribers a second time.
    dispatchPop(snap({ mode: 'calendar' }))
    expect(guard).toHaveBeenCalledTimes(1) // not called again for the echo
    expect(handler).not.toHaveBeenCalled() // still not notified

    unregister()
    unsubscribeHandler()
  })

  it('a guard returning true lets the pop through to subscribers', () => {
    const handler = vi.fn()
    const unsubscribeHandler = onPopNav(handler)
    const guard = vi.fn(() => true)
    const unregister = registerNavGuard(guard)

    dispatchPop(snap({ mode: 'packing' }))

    expect(guard).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(snap({ mode: 'packing' }))

    unregister()
    unsubscribeHandler()
  })

  it('unregister removes the guard', () => {
    const handler = vi.fn()
    const unsubscribeHandler = onPopNav(handler)
    const guard = vi.fn(() => false)
    const unregister = registerNavGuard(guard)
    unregister()

    dispatchPop(snap())

    expect(guard).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledWith(snap())

    unsubscribeHandler()
  })
})

describe('layerDepth', () => {
  it('root is 0', () => {
    expect(layerDepth(rootSnapshot())).toBe(0)
  })

  it('a trip at plain timeline is 1', () => {
    expect(layerDepth(snap())).toBe(1)
  })

  it('trip + packing is 2', () => {
    expect(layerDepth(snap({ mode: 'packing' }))).toBe(2)
  })

  it('trip + an overlay (timeline mode) is 2', () => {
    expect(layerDepth(snap({ overlay: { kind: 'settings' } }))).toBe(2)
  })

  it('trip + item + edit is 3', () => {
    expect(layerDepth(snap({ item: { id: 88, edit: true } }))).toBe(3)
  })

  it('null is 0', () => {
    expect(layerDepth(null)).toBe(0)
  })
})
