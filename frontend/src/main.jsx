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

  // Always listen for the controller changing. Skip only the very first claim on a
  // page that loaded uncontrolled (a fresh install / hard refresh — not an update);
  // every later change is a new deploy taking over → reload.
  let hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return }
    reload()
  })

  navigator.serviceWorker.register('/sw.js').then(reg => {
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
