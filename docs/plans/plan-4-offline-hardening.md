# Plan 4 — Offline hardening

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Current state (mostly built — this plan closes gaps)

The PWA already has meaningful offline support, in `frontend/vite.config.js`
(`VitePWA.workbox.runtimeCaching`):

- **NetworkFirst** (`api-reads` cache, 4s network timeout) for GET requests to
  paths starting with `/trips`, `/stops`, `/items`, `/import`.
- **CacheFirst** for flagcdn.com flag images.
- Precached app shell (`globPatterns`), SPA `navigateFallback`.
- `frontend/src/App.jsx` has a `useOnline()` hook and a global
  "Offline — read-only" banner, and skips pending-count polling while offline.

## Gaps to close

1. **Cold-start requests aren't all cached.** Trace the app's boot sequence in
   `frontend/src/App.jsx` / `frontend/src/api.js` — it hits at least
   `/auth/config`, `/trips/`, `/pending`, and per-trip `/trips/{id}/timeline`,
   `/trips/{id}/date-warnings`, `/pending?trip_id=`, `/weather?...`, `/health`.
   Of these, `/auth/config`, `/pending`, `/weather`, and `/health` are NOT
   under the cached path prefixes. Result: an offline cold start (app killed,
   airplane mode, reopen) can fail at the auth-config gate before the cached
   timeline is ever reached, and weather/day-headers degrade.

   Fix: extend the runtimeCaching config:
   - Add `/auth/config`, `/pending`, `/health` to the existing NetworkFirst
     API-reads pattern (same cache).
   - Add a separate NetworkFirst entry for `/weather` with its own cacheName
     (`weather`) and `expiration.maxAgeSeconds` of 24h — weather stales fast
     and shouldn't evict itinerary entries (the shared cache has
     `maxEntries: 100`).

2. **Boot must tolerate failures gracefully.** After the cache additions,
   verify each boot fetch either succeeds from cache or fails without blocking
   render (wrapped in `.catch`). Fix any unguarded one so a truly-first-run
   offline user gets the login/empty state instead of a blank page.

3. **Cache-key hygiene.** TripTimeline's silent refresh appends a
   `?sync=<timestamp>` cache-buster (`getTripTimeline(tripId, { sync: ... })`),
   which writes a uniquely-keyed cache entry per poll into `api-reads`
   (`maxEntries: 100` — these can evict useful entries). Exclude sync-busted
   URLs from caching: in the API-reads `urlPattern` function, return false when
   `url.searchParams.has('sync')`. The plain (non-sync) URL is fetched on every
   normal mount, so offline lookups still hit a fresh entry.

4. **Offline indicator on data age (small UX nicety, do last).** When the
   timeline renders while `!navigator.onLine`, show a one-line note under the
   header: "Showing cached data". Simplest: in `TripTimeline.jsx`, reuse the
   same `online`/`offline` event-listener pattern as `useOnline()` in App.jsx
   (or export that hook from App.jsx / move it to `frontend/src/settings.js`
   style module) and render the note conditionally. Don't attempt to compute
   actual cache age — out of scope.

## Tests

Workbox config isn't unit-testable here; the deliverables are:

- A vitest unit test only if you extract `useOnline` into a shared module
  (test the hook via `@testing-library/react` `renderHook` + window event
  dispatch). Skip if you leave it in place.
- **Manual verification protocol (required, document results in the PR/commit
  message):**
  1. `cd frontend && npm run build`, then serve the real built app via the
     backend (`python -m uvicorn backend.main:app`) — the dev server does NOT
     register the service worker; offline testing must use the built app at
     `http://localhost:8000`.
  2. Load a trip while online (lets SW populate caches).
  3. DevTools → Network → Offline. Reload the page: app shell + trip list +
     timeline must render from cache with the offline banner showing.
  4. Kill the tab, reopen offline (cold start): same result.
  5. Confirm no unhandled promise rejections in the console.

## Gotchas

- vite-plugin-pwa is in `generateSW` mode — you can only use the declarative
  `runtimeCaching` options (handler names, expiration, cacheableResponse,
  networkTimeoutSeconds), not custom Workbox plugins. The `urlPattern`
  functions run inside the generated SW, so keep them self-contained (no
  imports/closures over module state).
- Service workers persist aggressively between builds while testing — use
  DevTools → Application → Service Workers → "Update on reload", and clear
  storage between runs.
- This touches `frontend/` only. The vite.config.js change affects the build
  output, so the build/amend/push workflow applies even though nothing under
  `frontend/src/` changed — the pre-push hook checks `frontend/src/`, so if
  you ONLY change vite.config.js, rebuild anyway (the SW is part of
  `backend/static/`) and commit the rebuilt static output with it.
