import { useState, useEffect } from 'react'
import { getTrips, importFromSheets, deleteTrip } from '../api.js'

function fmtDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Pick the most relevant trip: active > soonest future > most recent past > first.
function findNextUpcoming(trips) {
  if (trips.length === 1) return trips[0]
  const now = new Date()
  const active = trips.filter(t =>
    t.start_date && new Date(t.start_date) <= now &&
    (!t.end_date || new Date(t.end_date) >= now)
  )
  if (active.length) return active.sort((a, b) => new Date(a.start_date) - new Date(b.start_date))[0]
  const future = trips.filter(t => t.start_date && new Date(t.start_date) > now)
  if (future.length) return future.sort((a, b) => new Date(a.start_date) - new Date(b.start_date))[0]
  const dated = trips.filter(t => t.start_date)
  if (dated.length) return dated.sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0]
  return trips[0]
}

export default function TripList({ onOpen, skipAutoOpen, restoreTripId = null, restoreToday = false }) {
  const [trips, setTrips] = useState([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [tripName, setTripName] = useState('')

  useEffect(() => { load(true) }, [])

  async function load(initial = false) {
    try {
      const data = await getTrips()
      setTrips(data)
      if (initial && !skipAutoOpen && data.length > 0) {
        // Restore whatever trip was open before a forced reload, in
        // preference to the usual "next upcoming trip" auto-pick.
        const restored = restoreTripId != null && data.find(t => t.id === restoreTripId)
        onOpen(restored || findNextUpcoming(data), restored ? restoreToday : undefined)
      }
    }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleImport() {
    const name = tripName.trim() || 'My Trip'
    setImporting(true); setError(null)
    try { await importFromSheets(name); setTripName(''); await load() }
    catch (e) { setError(e.message) }
    finally { setImporting(false) }
  }

  async function handleDelete(e, id) {
    e.stopPropagation()
    if (!confirm('Delete this trip and all its data?')) return
    try { await deleteTrip(id); await load() }
    catch (e) { setError(e.message) }
  }

  if (loading) return <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">Loading…</p>

  return (
    <div className="space-y-5">
      <div style={{ background: 'var(--surface)', borderRadius: '0.75rem' }} className="p-5 space-y-3">
        <p style={{ color: 'var(--text-muted)' }} className="text-xs uppercase tracking-wide font-medium">
          Import from Google Sheets
        </p>
        <div className="flex gap-3">
          <input
            style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', outline: 'none' }}
            className="flex-1 rounded-lg px-3 py-2 text-sm placeholder:text-[var(--text-faint)]"
            placeholder="Trip name (e.g. Europe 2026)"
            value={tripName}
            onChange={e => setTripName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleImport()}
          />
          <button
            onClick={handleImport}
            disabled={importing}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {importing && (
          <p style={{ color: 'var(--text-faint)' }} className="text-xs">
            Fetching sheets — a browser window may open for first-time Google authentication…
          </p>
        )}
      </div>

      {error && (
        <div
          style={{ background: 'color-mix(in srgb, var(--error) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 30%, transparent)', color: 'var(--error)' }}
          className="rounded-lg px-4 py-3 text-sm"
        >
          {error}
        </div>
      )}

      {trips.length === 0 ? (
        <p style={{ color: 'var(--text-faint)' }} className="text-center py-12 text-sm">
          No trips yet — import from Google Sheets to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {trips.map(trip => {
            const dateRange = trip.start_date || trip.end_date
              ? [fmtDate(trip.start_date), fmtDate(trip.end_date)].filter(Boolean).join(' → ')
              : null
            return (
              <div
                key={trip.id}
                onClick={() => onOpen(trip)}
                style={{ background: 'var(--surface)', borderRadius: '0.75rem' }}
                className="px-5 py-4 cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-between group"
              >
                <div>
                  <div className="font-medium">{trip.name}</div>
                  <div style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5">
                    {dateRange ?? `Added ${new Date(trip.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric'
                    })}`}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {trip.role && trip.role !== 'owner' && (
                    <span style={{ color: 'var(--text-faint)', border: '1px solid var(--border)' }}
                      className="text-xs px-2 py-0.5 rounded-full capitalize shrink-0">
                      {trip.role}
                    </span>
                  )}
                  <span style={{ color: 'var(--text-faint)' }}>→</span>
                  {trip.role === 'owner' && (
                    <button
                      onClick={e => handleDelete(e, trip.id)}
                      style={{ color: 'var(--text-faint)' }}
                      className="text-xs opacity-0 group-hover:opacity-100 transition-all hover:opacity-70"
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--error)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
