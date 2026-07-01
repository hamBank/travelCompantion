// Imported into the generated service worker (workbox importScripts).
// Handles incoming Web Push messages and notification taps.
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} }
  catch { data = { title: 'Travel Companion', body: event.data ? event.data.text() : '' } }

  const urgent = !!data.urgent
  const title = (urgent && data.title ? '⚠️ ' + data.title : (data.title || 'Travel Companion'))
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    silent: false,   // explicit — play the default notification sound
  }
  if (urgent) {
    options.requireInteraction = true   // stay visible until dismissed (where supported)
    options.vibrate = [200, 100, 200, 100, 200]
  }
  event.waitUntil(self.registration.showNotification(title, options))
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
