import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

let BUILD_SHA = 'dev'
try {
  // Use the SHA of the last commit touching this frontend's source so the value
  // is stable across amends that only add backend/static/ files. Path is relative
  // to cwd (frontend/), which is where vite.config.js executes from.
  BUILD_SHA = execSync('git log -1 --format=%h -- src').toString().trim()
  if (!BUILD_SHA) BUILD_SHA = execSync('git rev-parse --short HEAD').toString().trim()
} catch {}

// Writes build-sha.txt into the output dir so /health can return the frontend
// build SHA rather than git HEAD — preventing backend-only commits from
// triggering the SHA health-poller reload on all clients.
const writeBuildSha = {
  name: 'write-build-sha',
  closeBundle() {
    try { writeFileSync('../backend/static/build-sha.txt', BUILD_SHA) } catch {}
  },
}

export default defineConfig({
  define: { __BUILD_SHA__: JSON.stringify(BUILD_SHA) },
  plugins: [
    react(),
    writeBuildSha,
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
            // NetworkFirst for all GET API reads: fresh data when online,
            // cached copy when offline. Times out after 4s to surface cached
            // data quickly on slow connections.
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
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-reads',
              networkTimeoutSeconds: 4,
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
    },
  },
})
