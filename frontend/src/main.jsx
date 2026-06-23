import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

if ('serviceWorker' in navigator) {
  let reloading = false
  // Reload when an updated worker takes control — but not while the user is typing
  // in a field (would lose unsaved input); retry shortly until they're idle.
  const reload = () => {
    if (reloading) return
    const el = document.activeElement
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      setTimeout(reload, 5000)
      return
    }
    reloading = true
    window.location.reload()
  }

  // A new worker taking control means a new deploy is live → reload to use it.
  // (On a brand-new install this fires once, harmlessly, before any interaction.)
  navigator.serviceWorker.addEventListener('controllerchange', reload)

  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Tell a waiting worker to activate. The SW's own skipWaiting() isn't reliably
    // honored on Firefox while a client is controlled, so we prod it via message.
    const promote = () => { if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }) }
    if (reg.waiting) promote()  // an update may already be stuck waiting on load
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed') promote()
      })
    })

    // Poll for a new deploy so an already-open app updates itself without a re-open.
    const check = () => reg.update().catch(() => {})
    setInterval(check, 60 * 1000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
    })
  }).catch(() => {})
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
