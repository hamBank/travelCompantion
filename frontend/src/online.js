import { useState, useEffect } from 'react'

// ── Server-down tracking (deploys/restarts) ────────────────────────────────
// A deploy restarts the backend, so for a short window requests come back
// 502/503/504 even though the *browser* is online. api.js calls
// markServerDown() when it sees one; the app then behaves exactly like
// offline (banner, cached reads, queued writes) while a background poll
// watches /health. On recovery we announce SERVER_UP_EVENT and re-dispatch
// the browser's own 'online' event so everything keyed to reconnect (the
// offline write queue's flush, this hook) reacts with no extra wiring.

export const SERVER_DOWN_EVENT = 'tc-server-down'
export const SERVER_UP_EVENT = 'tc-server-up'
const SERVER_POLL_MS = 5000

let _serverDown = false
let _pollTimer = null

export function isServerDown() { return _serverDown }

export function markServerDown() {
  if (_serverDown) return
  _serverDown = true
  window.dispatchEvent(new Event(SERVER_DOWN_EVENT))
  _pollTimer = setInterval(async () => {
    try {
      const r = await fetch('/health', { cache: 'no-store' })
      if (!r.ok) return // still down
    } catch {
      return // unreachable — keep polling
    }
    clearInterval(_pollTimer)
    _pollTimer = null
    _serverDown = false
    window.dispatchEvent(new Event(SERVER_UP_EVENT))
    window.dispatchEvent(new Event('online'))
  }, SERVER_POLL_MS)
}

/** Test-only: clear the module-level down state and stop the poll. */
export function resetServerDownForTests() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
  _serverDown = false
}

/** Reactive hook — true only when the browser is online AND the server
 * isn't mid-deploy/restart. Shared by App.jsx (the global offline banner),
 * TripTimeline.jsx (the "showing cached data" note), and roles.js
 * (useCanQueueEdit — which is what routes writes through the offline queue
 * whenever this is false). */
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine && !_serverDown)
  useEffect(() => {
    // 'offline'/SERVER_DOWN force false; the two "up" events re-check the
    // other half of the condition, so coming back from a deploy while the
    // browser is genuinely offline (or vice versa) stays false.
    const down = () => setOnline(false)
    const up = () => setOnline(navigator.onLine && !_serverDown)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    window.addEventListener(SERVER_DOWN_EVENT, down)
    window.addEventListener(SERVER_UP_EVENT, up)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
      window.removeEventListener(SERVER_DOWN_EVENT, down)
      window.removeEventListener(SERVER_UP_EVENT, up)
    }
  }, [])
  return online
}
