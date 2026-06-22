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

// ── Show inbound flight/rail arrival on the destination stop ─────────────────
const SHOW_INBOUND_KEY = 'tc-show-inbound'

// Default ON (only stored value of '0' disables it).
export function getShowInbound() {
  return localStorage.getItem(SHOW_INBOUND_KEY) !== '0'
}

export function setShowInbound(value) {
  localStorage.setItem(SHOW_INBOUND_KEY, value ? '1' : '0')
  listeners.forEach(l => l())
}

export function useShowInbound() {
  return useSyncExternalStore(subscribe, getShowInbound)
}
