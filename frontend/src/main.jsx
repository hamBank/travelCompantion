import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  // Auto-reload once when an updated service worker takes control, so new deploys
  // appear without a manual hard-refresh (which isn't even possible in an iOS PWA).
  // Guarded by an existing controller so a first install doesn't trigger a reload.
  if (navigator.serviceWorker.controller) {
    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    })
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
