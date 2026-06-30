import { useEffect } from 'react'

/**
 * Mobile swipe navigation for detail modals — the touch analogue of j/k.
 *
 * A horizontal swipe dispatches the same `modalNav` CustomEvent the keyboard
 * handler uses, so it reuses TripTimeline's cross-stop next/prev logic:
 *   swipe left  → next      swipe right → prev
 *
 * Mostly-vertical gestures (scrolling) and short taps are ignored.
 */
const MIN_DX = 60          // px of horizontal travel required
const H_OVER_V = 1.5       // horizontal must dominate vertical by this factor

export function useSwipeNav(itemId) {
  useEffect(() => {
    let startX = 0, startY = 0, tracking = false

    const onStart = e => {
      if (!e.touches || e.touches.length !== 1) { tracking = false; return }
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      tracking = true
    }
    const onEnd = e => {
      if (!tracking) return
      tracking = false
      const t = (e.changedTouches && e.changedTouches[0]) || null
      if (!t) return
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      if (Math.abs(dx) < MIN_DX) return                 // too short / a tap
      if (Math.abs(dx) < Math.abs(dy) * H_OVER_V) return // mostly vertical → scroll
      const direction = dx < 0 ? 'next' : 'prev'
      window.dispatchEvent(new CustomEvent('modalNav', { detail: { itemId, direction } }))
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
    }
  }, [itemId])
}
