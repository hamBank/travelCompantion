// Persists "which trip / which view mode was open" so a forced page reload
// (see main.jsx's update banner) doesn't feel like starting over. localStorage
// (not sessionStorage) — a backgrounded iOS PWA can have its whole process
// terminated by the OS and relaunched fresh, which behaves like a cold boot
// from disk, not an in-page reload; sessionStorage isn't reliably guaranteed
// to survive that, localStorage is.
const NAV_KEY = 'tc-last-nav'

export function getSavedNav() {
  try {
    const raw = localStorage.getItem(NAV_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && parsed.tripId != null ? parsed : null
  } catch {
    return null
  }
}

export function saveNav({ tripId, today }) {
  try {
    localStorage.setItem(NAV_KEY, JSON.stringify({ tripId, today }))
  } catch { /* storage unavailable/full — losing the restore point is fine */ }
}

export function clearNav() {
  try { localStorage.removeItem(NAV_KEY) } catch { /* ignore */ }
}
