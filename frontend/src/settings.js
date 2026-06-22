import { useSyncExternalStore } from 'react'

// ── Hide completed items (global display preference) ─────────────────────────
const HIDE_COMPLETED_KEY = 'tc-hide-completed'
const listeners = new Set()

export function getHideCompleted() {
  return localStorage.getItem(HIDE_COMPLETED_KEY) === '1'
}

export function setHideCompleted(value) {
  localStorage.setItem(HIDE_COMPLETED_KEY, value ? '1' : '0')
  listeners.forEach(l => l())
}

function subscribe(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Reactive hook — re-renders when the hide-completed preference changes. */
export function useHideCompleted() {
  return useSyncExternalStore(subscribe, getHideCompleted)
}
