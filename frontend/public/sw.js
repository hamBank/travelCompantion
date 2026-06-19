const CACHE = 'osm-tiles-v1'
const MAX_TILES = 500

self.addEventListener('install', e => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', e => {
  if (!e.request.url.includes('tile.openstreetmap.org')) return

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const hit = await cache.match(e.request)
      if (hit) return hit

      const resp = await fetch(e.request)
      if (resp.ok) {
        cache.put(e.request, resp.clone())
        pruneCache(cache)
      }
      return resp
    }).catch(() => caches.match(e.request))
  )
})

async function pruneCache(cache) {
  const keys = await cache.keys()
  if (keys.length > MAX_TILES) {
    for (const key of keys.slice(0, keys.length - MAX_TILES)) {
      cache.delete(key)
    }
  }
}
