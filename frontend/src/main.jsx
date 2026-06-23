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

  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Poll for a new deploy so an already-open app updates itself without a re-open.
    const check = () => reg.update().catch(() => {})
    setInterval(check, 60 * 1000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check()
    })
  }).catch(() => {})

  // Guarded by an existing controller so a first install doesn't trigger a reload.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', reload)
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
