import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
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

// ── SHA health-check: compare server git HEAD with the SHA baked into this build ─
// This is the primary reload trigger. It works regardless of SW state and catches
// cases where the SW update cycle gets stuck (worker waiting, tab was backgrounded,
// controllerchange never fired, etc.).
;(function startShaPoller() {
  if (typeof __BUILD_SHA__ === 'undefined' || __BUILD_SHA__ === 'dev') return
  async function check() {
    try {
      const { sha } = await fetch('/health', { cache: 'no-store' }).then(r => r.json())
      if (sha && sha !== __BUILD_SHA__) safeReload()
    } catch { /* offline — ignore */ }
  }
  setInterval(check, 60_000)
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
})()

// ── Service worker: secondary reload path via controllerchange ─────────────────
if ('serviceWorker' in navigator) {
  // SW taking control = new deploy is active → reload (safeReload guards against
  // double-reload if the SHA check already fired).
  navigator.serviceWorker.addEventListener('controllerchange', safeReload)

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
