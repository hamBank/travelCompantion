import { useState, useEffect } from 'react'
import { getTripDistance, getMyDistanceTotals } from '../api.js'

// Mirrors backend/distance.py's TRANSPORT_MODE values.
const MODE_LABEL = { air: 'Air', rail: 'Rail', road: 'Road', bike: 'Bike', walking: 'Walking', boat: 'Boat' }
const MODE_ICON  = { air: '✈', rail: '🚄', road: '🚗', bike: '🚲', walking: '🚶', boat: '⛴' }
const MODE_ORDER = ['air', 'rail', 'road', 'bike', 'walking', 'boat']

function fmtKm(km) {
  return `${km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(1)} km`
}

function ModeTable({ byMode }) {
  const rows = MODE_ORDER.filter(m => byMode[m] != null)
  if (rows.length === 0) {
    return <p style={{ color: 'var(--text-faint)' }} className="text-xs">No distance-bearing items yet.</p>
  }
  const max = Math.max(...rows.map(m => byMode[m]))
  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map(mode => (
          <tr key={mode}>
            <td style={{ color: 'var(--text-muted)' }} className="py-1 pr-2 whitespace-nowrap">
              {MODE_ICON[mode]} {MODE_LABEL[mode]}
            </td>
            <td className="py-1 w-full">
              <div style={{ background: 'var(--surface-2)', borderRadius: '999px', height: '6px' }}>
                <div style={{
                  width: `${(byMode[mode] / max) * 100}%`,
                  background: 'var(--accent)', height: '100%', borderRadius: '999px',
                }} />
              </div>
            </td>
            <td style={{ color: 'var(--text)' }} className="py-1 pl-2 text-right whitespace-nowrap">{fmtKm(byMode[mode])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function DistanceSummary({ trip, onClose }) {
  const [tripData, setTripData] = useState(null)
  const [meData, setMeData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (trip?.id) getTripDistance(trip.id).then(setTripData).catch(e => setError(e.message))
    getMyDistanceTotals().then(setMeData).catch(() => {})
  }, [trip?.id])

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)' }} className="w-full max-w-md rounded-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">🧭 Distance</span>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-sm hover:opacity-70">✕</button>
        </div>

        <div className="px-4 py-4 space-y-4 overflow-y-auto">
          {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">This trip</span>
              {tripData && <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">{fmtKm(tripData.total_km)}</span>}
            </div>
            {tripData ? <ModeTable byMode={tripData.by_mode} /> : (
              <p style={{ color: 'var(--text-faint)' }} className="text-xs">Loading…</p>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border)' }} className="pt-3">
            <div className="flex items-baseline justify-between mb-1.5">
              <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Lifetime (all your trips)</span>
              {meData && <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">{fmtKm(meData.total_km)}</span>}
            </div>
            {meData ? <ModeTable byMode={meData.by_mode} /> : (
              <p style={{ color: 'var(--text-faint)' }} className="text-xs">Loading…</p>
            )}
          </div>

          <p style={{ color: 'var(--text-faint)' }} className="text-xs">
            Best-available estimate per item — a real GPS track or road-routed distance where one exists,
            straight-line distance between locations otherwise. Items with no usable location data aren't counted.
          </p>
        </div>
      </div>
    </div>
  )
}
