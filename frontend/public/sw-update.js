// Imported into the generated service worker (workbox importScripts). Lets the
// page promote a waiting worker to active — Firefox doesn't reliably honor the
// SW's top-level self.skipWaiting() when a client is already controlled.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting()
})
