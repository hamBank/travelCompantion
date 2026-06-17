import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
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
        // Cache all built assets forever (they're content-hashed)
        globPatterns: ['**/*.{js,css,html,woff2}'],
        runtimeCaching: [
          {
            // NetworkFirst for all GET API reads: fresh data when online,
            // cached copy when offline. Times out after 4s to surface cached
            // data quickly on slow connections.
            urlPattern: ({ request, url }) =>
              request.method === 'GET' &&
              ['/trips', '/stops', '/items', '/import'].some(p => url.pathname.startsWith(p)),
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
    },
  },
})
