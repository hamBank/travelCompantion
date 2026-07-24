import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { SERVER_UP_EVENT } from './online.js'
import './index.css'

// ── Reload guard — never reload while the user is actively typing ──────────────
let reloading = false
function safeReload() {
  if (reloading) return
  const el = document.activeElement
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    setTimeout(safeReload, 5000)
    return
  }
  reloading = true
  window.location.reload()
}

// ── Update banner — tell the user, don't reload out from under them ────────────
// A silent forced location.reload() on every foreground was throwing away
// in-memory navigation state (which trip/day was open) on every app switch —
// on iOS in particular, reported happening on nearly every switch, far more
// often than real deploys land. A dismissible banner lets the user apply the
// update on their own terms instead. `key` dedupes repeat detections of the
// same update (a fresh sha, or the generic 'sw-update' marker) so re-checking
// on every focus doesn't re-nag after a dismissal.
function announceUpdateAvailable(key) {
  if (sessionStorage.getItem('tc-dismissed-update') === key) return
  if (document.getElementById('tc-update-banner')) return

  const bar = document.createElement('div')
  bar.id = 'tc-update-banner'
  bar.setAttribute('role', 'status')
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;'
    + 'display:flex;align-items:center;justify-content:space-between;gap:0.75rem;'
    + 'padding:0.75rem 1rem;padding-bottom:calc(0.75rem + env(safe-area-inset-bottom));'
    + 'background:#1e1e2e;color:#fff;font:13px -apple-system,system-ui,sans-serif;'
    + 'box-shadow:0 -2px 8px rgba(0,0,0,0.25);'

  const msg = document.createElement('span')
  msg.textContent = 'A new version is available.'

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;align-items:center;gap:0.5rem;flex-shrink:0;'

  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = 'Refresh'
  refreshBtn.style.cssText = 'background:#a78bfa;color:#1e1e2e;border:none;border-radius:8px;'
    + 'padding:0.4rem 0.8rem;font-weight:600;font-size:13px;cursor:pointer;'
  refreshBtn.onclick = safeReload

  const dismissBtn = document.createElement('button')
  dismissBtn.textContent = '✕'
  dismissBtn.setAttribute('aria-label', 'Dismiss')
  dismissBtn.style.cssText = 'background:transparent;color:#aaa;border:none;font-size:1rem;'
    + 'line-height:1;cursor:pointer;padding:0.25rem;'
  dismissBtn.onclick = () => {
    try { sessionStorage.setItem('tc-dismissed-update', key) } catch { /* ignore */ }
    bar.remove()
  }

  actions.append(refreshBtn, dismissBtn)
  bar.append(msg, actions)
  document.body.appendChild(bar)
}

// ── SHA health-check: compare server git HEAD with the SHA baked into this build ─
// Works regardless of SW state and catches cases where the SW update cycle
// gets stuck (worker waiting, tab was backgrounded, controllerchange never
// fired, etc.).
;(function startShaPoller() {
  if (typeof __BUILD_SHA__ === 'undefined' || __BUILD_SHA__ === 'dev') return
  async function check() {
    try {
      const { sha } = await fetch('/health', { cache: 'no-store' }).then(r => r.json())
      if (sha && sha !== __BUILD_SHA__) announceUpdateAvailable(sha)
    } catch { /* offline — ignore */ }
  }
  setInterval(check, 60_000)
  // The server just came back from a deploy/restart (see online.js) — check
  // immediately instead of waiting out the 60s interval, so a new build
  // sneaks in the moment the site recovers rather than up to a minute later.
  window.addEventListener(SERVER_UP_EVENT, check)
  // Mobile OSes throttle/suspend setInterval while a PWA is backgrounded, so
  // the 60s timer can sit dormant far longer than 60s of real time — a phone
  // reopened after a deploy could stay on a stale build well past when the
  // next tick "should" have fired. Re-checking on foreground (mirroring the
  // SW update check just below, which already does this) closes that gap.
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
})()

// ── Service worker: secondary update signal via controllerchange ───────────────
if ('serviceWorker' in navigator) {
  // SW taking control = new deploy is active — same banner as the SHA check
  // (announceUpdateAvailable no-ops if one's already showing/dismissed).
  navigator.serviceWorker.addEventListener('controllerchange', () => announceUpdateAvailable('sw-update'))

  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Tell a waiting worker to activate. The SW's own skipWaiting() isn't reliably
    // honored on Firefox while a client is controlled, so we prod it via message.
    const promote = () => { if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }) }
    if (reg.waiting) promote()
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed') promote()
      })
    })

    // Also trigger an SW update check on the same schedule as the SHA check.
    const swCheck = () => reg.update().catch(() => {})
    setInterval(swCheck, 60_000)
    window.addEventListener('focus', swCheck)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') swCheck()
    })
  }).catch(() => {})
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
