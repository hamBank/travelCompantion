import { useState, useEffect } from 'react'
import { getTrips, importFromSheets, deleteTrip } from '../api.js'

export default function TripList({ onOpen }) {
  const [trips, setTrips] = useState([])
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [tripName, setTripName] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    try { setTrips(await getTrips()) }
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

  if (loading) return <p style={{ color: '#6c7086' }} className="text-center py-12 text-sm">Loading…</p>

  return (
    <div className="space-y-5">
      {/* Import panel */}
      <div style={{ background: '#2a2a3e' }} className="rounded-xl p-5 space-y-3">
        <p style={{ color: '#9399b2' }} className="text-xs uppercase tracking-wide font-medium">
          Import from Google Sheets
        </p>
        <div className="flex gap-3">
          <input
            style={{ background: '#313244', color: '#cdd6f4', outline: 'none' }}
            className="flex-1 rounded-lg px-3 py-2 text-sm placeholder:text-[#6c7086]"
            placeholder="Trip name (e.g. Europe 2026)"
            value={tripName}
            onChange={e => setTripName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleImport()}
          />
          <button
            onClick={handleImport}
            disabled={importing}
            style={{ background: '#cba6f7', color: '#1e1e2e' }}
            className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {importing && (
          <p style={{ color: '#6c7086' }} className="text-xs">
            Fetching sheets — a browser window may open for first-time Google authentication…
          </p>
        )}
      </div>

      {error && (
        <div style={{ background: '#f38ba820', border: '1px solid #f38ba840', color: '#f38ba8' }}
          className="rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {trips.length === 0 ? (
        <p style={{ color: '#6c7086' }} className="text-center py-12 text-sm">
          No trips yet — import from Google Sheets to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {trips.map(trip => (
            <div
              key={trip.id}
              onClick={() => onOpen(trip)}
              style={{ background: '#2a2a3e' }}
              className="rounded-xl px-5 py-4 cursor-pointer hover:opacity-80 transition-opacity flex items-center justify-between group"
            >
              <div>
                <div className="font-medium">{trip.name}</div>
                <div style={{ color: '#6c7086' }} className="text-xs mt-0.5">
                  {new Date(trip.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', year: 'numeric'
                  })}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span style={{ color: '#6c7086' }}>→</span>
                <button
                  onClick={e => handleDelete(e, trip.id)}
                  style={{ color: '#6c7086' }}
                  className="text-xs opacity-0 group-hover:opacity-100 hover:text-[#f38ba8] transition-all"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
