import { useState, useEffect } from 'react'
import { getSharedTimeline } from '../api.js'
import StopCard from './StopCard.jsx'
import { RoleContext } from '../roles.js'

// Read-only view for a public trip share link (GET /shared/{token}, handled
// client-side — see App.jsx). Deliberately a lightweight component rather
// than reusing all of TripTimeline: TripTimeline carries a lot of stateful,
// editor-only machinery (document import, pending-review, past-pending
// catch-up banner, date-warning banner, today-view day navigation, j/k
// cross-item modal nav, the 30s data-sync poller) that either requires edit
// access or authenticated endpoints outright. None of it applies to an
// anonymous read-only viewer, so duplicating TripTimeline's ~500 lines just
// to strip all of that back out would be more code, not less. StopCard is
// reused as-is (it already renders correctly in a read-only role — see
// useCanEdit()/RoleContext below) so per-kind card rendering isn't
// duplicated either.
//
// RoleContext is forced to 'viewer' here (independent of whatever role the
// backend would compute for the actual signed-in owner) so every StopCard's
// canEdit is false: no status-cycle buttons, no add/edit/delete affordances.
// This mirrors what the backend already forces server-side (GET
// /shared/{token}/timeline always returns role: "viewer" — see
// backend/routers/trips.py's build_trip_timeline), belt-and-braces.
//
// Note on billed endpoints: StopCard's weather lookups (getWeather) hit the
// public /weather endpoint and work fine here. Per-item "Show map" buttons
// (river-map / gpx-map) and Today-view's day-map are Static-Maps-backed and
// stay behind require_item_role/require_stop_role (Bearer-auth only, see
// backend/routers/items.py) — this view has no auth token, so those calls
// 401 and the map silently fails to render (fetchGpxMapBlob/
// fetchRiverMapBlob/fetchDayMapBlob in api.js already treat a non-ok
// response as "no image" rather than throwing). day-map specifically is
// never wired up here at all (only TripTimeline's Today mode renders
// <DayMap>), so the only exposure surface is those per-item map buttons,
// which fail closed.
export default function SharedTripView({ token }) {
  const [timeline, setTimeline] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getSharedTimeline(token)
      .then(tl => { if (!cancelled) setTimeline(tl) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [token])

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header
        className="px-3 sm:px-6 py-3 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <h1 style={{ color: 'var(--accent)' }} className="font-semibold text-sm truncate">
          {timeline ? timeline.name : '✈ Travel Companion'}
        </h1>
        <span style={{ color: 'var(--text-faint)' }} className="text-xs ml-auto shrink-0">
          Shared read-only view
        </span>
      </header>

      <main className="w-full px-4 sm:px-8 lg:px-16 py-6">
        {!timeline && !error && (
          <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading…</p>
        )}
        {error && (
          <p style={{ color: 'var(--error)' }} className="text-center py-12 text-sm">{error}</p>
        )}
        {timeline && !timeline.stops?.length && (
          <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">No stops yet.</p>
        )}
        {timeline?.stops?.length > 0 && (
          <RoleContext.Provider value="viewer">
            <div className="space-y-1.5">
              {timeline.stops.map((stop, i) => (
                <StopCard key={stop.id} stop={stop} index={i} onUpdate={() => {}} />
              ))}
            </div>
          </RoleContext.Provider>
        )}
      </main>
    </div>
  )
}
