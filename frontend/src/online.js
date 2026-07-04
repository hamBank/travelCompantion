import { useState, useEffect } from 'react'

/** Reactive hook — tracks navigator.onLine, updating on the browser's
 * online/offline events. Shared by App.jsx (the global offline banner) and
 * TripTimeline.jsx (the "showing cached data" note). */
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}
