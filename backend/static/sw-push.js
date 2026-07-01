// Imported into the generated service worker (workbox importScripts).
// Handles incoming Web Push messages and notification taps.
//
// TEMPORARY: also beacons a diagnostic POST to /push/debug-log so we can see
// what actually happened on devices we have no console access to. Remove the
// beacon calls once push delivery is confirmed working end to end.
function beacon(info) {
  console.log('[sw-push]', info)
  try {
    fetch('/push/debug-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: new Date().toISOString(), ...info }),
    }).catch(() => {})
  } catch (e) { /* ignore */ }
}

// Fires for EVERY event this worker receives, not just 'push' — if a push
// event is being dropped before it even reaches our JS, this line alone
// (visible in Web Inspector) tells us whether the worker woke up at all.
self.addEventListener('message', (e) => {
  if (e.data && e.data.__diag) console.log('[sw-push] worker is alive, received message', e.data)
})

self.addEventListener('push', (event) => {
  beacon({ stage: 'push-event-received', hasData: !!event.data })

  event.waitUntil((async () => {
    let data = {}
    try {
      data = event.data ? event.data.json() : {}
      beacon({ stage: 'parsed-json', data })
    } catch (err) {
      try {
        data = { title: 'Travel Companion', body: event.data ? event.data.text() : '' }
        beacon({ stage: 'parsed-text-fallback', error: String(err), data })
      } catch (err2) {
        beacon({ stage: 'parse-failed-completely', error: String(err2) })
      }
    }

    const title = data.title || 'Travel Companion'
    const options = {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    }
    try {
      await self.registration.showNotification(title, options)
      beacon({ stage: 'shown', title })
    } catch (err) {
      beacon({ stage: 'show-failed', error: String(err) })
    }
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus()
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
    })
  )
})
