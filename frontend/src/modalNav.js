/**
 * Lightweight registry for the currently-open detail modal.
 *
 * Each modal registers itself on mount so the global j/k handler
 * knows which close function to call when navigating away.
 */

let _current = null   // { itemId: number, closeFn: () => void }

export function registerModal(itemId, closeFn) {
  _current = { itemId, closeFn }
}

export function unregisterModal() {
  _current = null
}

export function getCurrentModal() {
  return _current
}
