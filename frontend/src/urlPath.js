// Shareable deep-link URLs for a trip, a stop, or an item (plan: "copy link").
// No general-purpose router — the rest of the app's modes (Calendar, Edit,
// Packing, overlays, a planning draft) have no URL of their own and simply
// keep whatever deep-linkable path was last set, exactly like replaceNav's
// existing no-op guard already does for any other repeated snapshot. Only
// the three things a link can point at get their own path:
//
//   /t/:tripId                → the trip (Timeline)
//   /t/:tripId/day/:day       → Today mode on a specific day ("day" is
//                               YYYY-MM-DD)
//   /t/:tripId/item/:itemId   → Today mode with that item's detail open
//   /t/:tripId/stop/:stopId   → resolves once the trip's data has loaded to
//                               the Today-mode day the stop starts on, then
//                               replaces this URL with the canonical
//                               /day/ form above (see TripTimeline.jsx's
//                               initialStopId handling) — so a copied link
//                               still lands correctly even if the stop's
//                               dates change after it was shared.
//
// A browser hitting one of these paths directly (no app state yet — a cold
// load, or a share recipient who's never opened the app) is served the SPA
// shell by GET /t/{path:path} (backend/main.py), mirroring GET /shared/
// {token} in routers/shared.py. The React app then parses
// location.pathname itself (App.jsx's boot effect) and opens the right
// trip/day/item once it has loaded.

const DEEP_LINK_RE = /^\/t\/(\d+)(?:\/(day|item|stop)\/([^/]+))?\/?$/

// Builds the canonical path for a historyNav.js snapshot, or '/' for the
// root (trip list) / any state this scheme doesn't address.
export function snapshotToPath(snapshot) {
  if (!snapshot || snapshot.tripId == null) return '/'
  if (snapshot.item) return `/t/${snapshot.tripId}/item/${snapshot.item.id}`
  if (snapshot.mode === 'today' && snapshot.day) return `/t/${snapshot.tripId}/day/${snapshot.day}`
  return `/t/${snapshot.tripId}`
}

// Parses a location.pathname into a deep-link target, or null if it isn't
// one of these paths at all (the common case — most of the app's history
// never touches this scheme). `kind` is null for a bare trip link.
export function parseDeepLinkPath(pathname) {
  const m = DEEP_LINK_RE.exec(pathname || '')
  if (!m) return null
  const tripId = Number(m[1])
  if (!Number.isFinite(tripId)) return null
  return { tripId, kind: m[2] || null, value: m[3] ? decodeURIComponent(m[3]) : null }
}
