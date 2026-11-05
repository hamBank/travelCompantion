import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// Build identity (fleet spec BLD-2). Two different questions, two values:
//  - frontend_sha: last commit that touched this frontend's source. Baked into
//    the bundle as __BUILD_SHA__ and compared by the stale-client poller, so a
//    backend-only deploy doesn't make every open client reload. Stable across
//    amends that only add backend/static/ files. Path is relative to cwd
//    (frontend/), which is where vite.config.js executes from.
//  - build_sha: HEAD when the build ran, i.e. the commit that was deployed.
//    After a deploy it must equal the backend's own HEAD; smoke_check.sh
//    asserts that, which catches a build that was skipped or failed.
// BUILD_SHA / FRONTEND_SHA env vars cover builds with no .git (CI, Docker).
function resolveVersion() {
  let build = process.env.BUILD_SHA || ''
  let frontend = process.env.FRONTEND_SHA || ''
  try {
    if (!build) build = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (!frontend) frontend = execSync('git log -1 --format=%h -- src', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {}
  return { build, frontend: frontend || build }
}

// Writes version.json (and the older build-sha.txt, still read by the
// pre-push hook and /health's fallback) into the output dir so /health can
// report what this bundle is, read fresh per request.
function writeVersion(version) {
  return {
    name: 'write-version',
    closeBundle() {
      try {
        writeFileSync('../backend/static/version.json', JSON.stringify({
          build_sha: version.build,
          frontend_sha: version.frontend,
          built_at: new Date().toISOString(),
        }))
        writeFileSync('../backend/static/build-sha.txt', version.frontend)
      } catch {}
    },
  }
}

export default defineConfig(({ command }) => {
  const version = resolveVersion()
  // No silent 'unknown': a production build with no way to tell which commit
  // it is would make the post-deploy identity check meaningless (BLD-3).
  // `vite dev` and vitest keep working without git.
  if (command === 'build' && !version.build) {
    throw new Error('Cannot determine the commit being built: no git checkout and no BUILD_SHA env var')
  }
  return {
  define: { __BUILD_SHA__: JSON.stringify(command === 'build' ? version.frontend : 'dev') },
  plugins: [
    react(),
    writeVersion(version),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Travel Companion',
        short_name: 'Travel',
        description: 'Your offline travel itinerary',
        theme_color: '#1e1e2e',
        background_color: '#1e1e2e',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Adds a message handler so the page can promote a waiting worker (Firefox
        // doesn't reliably auto-activate on the SW's own skipWaiting()).
        importScripts: ['sw-update.js', 'sw-push.js'],
        // The SPA navigation fallback serves index.html for every navigation; exclude
        // /coverage so its server-rendered reports aren't hijacked into the app.
        navigateFallbackDenylist: [/^\/coverage/, /^\/metrics/],
        // Cache all built assets forever (they're content-hashed)
        globPatterns: ['**/*.{js,css,html,woff2}'],
        runtimeCaching: [
          {
            // Static Maps proxy images (river-map/gpx-map/day-map) —
            // StaleWhileRevalidate: show the cached image instantly (works
            // offline), and if online, revalidate against the backend in the
            // background so a genuinely updated map (e.g. a corrected
            // river/GPX path) replaces the cached copy for next time. A given
            // set of inputs (path points / locations) usually renders the
            // same image, but unlike CacheFirst this doesn't commit to that
            // for a full week without ever checking. Must be listed before
            // the api-reads rule below, which would otherwise NetworkFirst-
            // match river-map/gpx-map first (they're under /items) and never
            // let this rule take over.
            urlPattern: ({ request, url }) =>
              request.method === 'GET' &&
              (/^\/items\/\d+\/(river|gpx)-map$/.test(url.pathname) ||
                /^\/stops\/\d+\/day-map$/.test(url.pathname)),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'static-maps',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // StaleWhileRevalidate for all GET API reads: a cached copy (when
            // present) resolves immediately so first paint never blocks on the
            // network, while a background fetch silently refreshes the cache
            // for next time. This used to be NetworkFirst with a 4s timeout,
            // which meant every cold boot — online or off — waited up to 4s
            // per request (auth config, then trips, sequentially) before any
            // cached content could render. Real-time freshness is still
            // covered by TripTimeline's separate data_version poller, so
            // trading "always network-fresh on first paint" for "instant paint,
            // refreshed shortly after" doesn't lose update-detection — it just
            // stops the first paint from waiting on it.
            //
            // /auth/config, /pending, and /health are included alongside the
            // itinerary paths so a cold start while offline (app killed,
            // airplane mode, reopen) can get past the auth gate and the
            // pending-imports badge without ever reaching the network — a
            // trip's cached timeline is useless if boot fails before it.
            //
            // ?sync= busted URLs are excluded defensively (TripTimeline no
            // longer sends them — plain URLs keep this cache's offline copy
            // fresh on every silent refresh — but any future one-off busted
            // URL would otherwise fill the 100-entry cap and evict the plain
            // URLs that offline loads actually look up).
            urlPattern: ({ request, url }) =>
              request.method === 'GET' &&
              !url.searchParams.has('sync') &&
              ['/trips', '/stops', '/items', '/import', '/auth', '/pending', '/health'].some(p => url.pathname.startsWith(p)),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'api-reads',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Weather forecasts — NetworkFirst like the API reads above, but in
            // its own cache with a short max age: forecasts stale out within a
            // day and shouldn't compete with (and evict) itinerary entries in
            // api-reads, which has a much longer intended lifetime.
            urlPattern: ({ request, url }) =>
              request.method === 'GET' && url.pathname.startsWith('/weather'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'weather',
              networkTimeoutSeconds: 4,
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 24 * 60 * 60,
              },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Flag images (flagcdn) — CacheFirst so they render offline after the
            // first load and aren't re-fetched. Static content, long-lived.
            urlPattern: ({ url }) => url.hostname === 'flagcdn.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'flag-images',
              expiration: { maxEntries: 100, maxAgeSeconds: 180 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OpenStreetMap raster tiles — used by the cycling item detail
            // view's GPX mini-map (GpxMapCanvas in ItemDetailModal.jsx), which
            // draws its own map from these tiles instead of the backend-proxied
            // Static Maps image the walk/river/day-map cards use. Without this
            // rule these tiles had no caching at all, so the cycling mini-map
            // was blank offline even after being viewed online. CacheFirst
            // since a given z/x/y tile's imagery is effectively static.
            urlPattern: ({ url }) => url.hostname === 'tile.openstreetmap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: { maxEntries: 1000, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/trips': 'http://localhost:8000',
      '/stops': 'http://localhost:8000',
      '/items': 'http://localhost:8000',
      '/import': 'http://localhost:8000',
      '/auth': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/weather': 'http://localhost:8000',
      '/me': 'http://localhost:8000',
    },
  },
  }
})
