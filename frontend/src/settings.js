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

// ── Hide stop frames (show items only, no location header or outer card) ──────
const HIDE_STOP_FRAMES_KEY = 'tc-hide-stop-frames'

export function getHideStopFrames() {
  return localStorage.getItem(HIDE_STOP_FRAMES_KEY) === '1'
}

export function setHideStopFrames(value) {
  localStorage.setItem(HIDE_STOP_FRAMES_KEY, value ? '1' : '0')
  listeners.forEach(l => l())
}

export function useHideStopFrames() {
  return useSyncExternalStore(subscribe, getHideStopFrames)
}

// ── Font scale (applied as root font-size; all rem values scale with it) ─────
const FONT_SCALE_KEY = 'tc-font-scale'
export const FONT_SCALE_OPTIONS = [
  { label: 'Small',   value: '14' },
  { label: 'Default', value: '16' },
  { label: 'Large',   value: '18' },
  { label: 'XLarge',  value: '20' },
]
const DEFAULT_FONT_SCALE = '16'

export function getFontScale() {
  return localStorage.getItem(FONT_SCALE_KEY) || DEFAULT_FONT_SCALE
}

export function setFontScale(px) {
  localStorage.setItem(FONT_SCALE_KEY, px)
  document.documentElement.style.fontSize = `${px}px`
  listeners.forEach(l => l())
}

// ── Kind filter (session-only view filter, not persisted) ────────────────────
import { createContext, useContext } from 'react'

export const KindFilterContext = createContext('')

/** Returns the active kind filter string, or '' for "all". */
export function useKindFilter() {
  return useContext(KindFilterContext)
}

export function applyFontScale() {
  const px = getFontScale()
  document.documentElement.style.fontSize = `${px}px`
}

export function useFontScale() {
  return useSyncExternalStore(subscribe, getFontScale)
}
