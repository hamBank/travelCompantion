import { useEffect } from 'react'

/**
 * Generic mobile swipe navigation — the touch analogue of j/k.
 *
 * A horizontal swipe calls `onDirection('next' | 'prev')`:
 *   swipe left  → next      swipe right → prev
 *
 * Mostly-vertical gestures (scrolling) and short taps are ignored. Pass
 * `enabled = false` to skip attaching listeners (e.g. a feature that's only
 * navigable in one particular mode).
 *
 * A horizontal drag that selected text (e.g. dragging across a booking ref to
 * copy it in a detail modal) also produces horizontal travel, so we bail when
 * there's an active text selection — otherwise selecting text would navigate
 * away instead.
 */
const MIN_DX = 60          // px of horizontal travel required
const H_OVER_V = 1.5       // horizontal must dominate vertical by this factor

// True while the user has text selected — a select-drag, not a swipe.
function hasTextSelection() {
  const sel = typeof window !== 'undefined' && window.getSelection && window.getSelection()
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0
}

export function useSwipeNav(onDirection, enabled = true) {
  useEffect(() => {
    if (!enabled) return
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
      if (hasTextSelection()) return                     // selecting text, not swiping
      onDirection(dx < 0 ? 'next' : 'prev')
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
    }
  }, [onDirection, enabled])
}
