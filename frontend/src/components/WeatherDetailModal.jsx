import { useEffect, useState } from 'react'
import { getHourlyWeather } from '../api.js'
import { fmtDayHeader } from '../dates.js'
import { Sunrise, Sunset, Droplets, Wind } from 'lucide-react'

/** Hourly click-through behind a day banner. Only ever opened for a day
 * whose summary weather.source === 'forecast' (see DayBanner) — climatology
 * days have no meaningful hourly shape to show, so this component doesn't
 * need to handle that case; the backend 404s it defensively anyway. */
export default function WeatherDetailModal({ dateKey, source, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getHourlyWeather(source?.lat, source?.lng, dateKey, source?.query)
      .then(r => { if (!cancelled) setData(r.hourly) })
      .catch(e => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [dateKey, source?.lat, source?.lng, source?.query])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: 'var(--modal-bg)',
          border: '1px solid var(--border)',
          maxWidth: '26rem',
          width: '100%',
          maxHeight: '80vh',
          borderRadius: '0.75rem',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}
          className="px-5 py-4 flex items-center justify-between"
        >
          <div className="font-semibold text-sm">{fmtDayHeader(dateKey)}</div>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-faint)' }}
            className="text-lg leading-none hover:opacity-70 shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 flex-1">
          {error && <p style={{ color: 'var(--error)' }} className="text-sm">{error}</p>}
          {!error && !data && (
            <p style={{ color: 'var(--text-faint)' }} className="text-sm">Loading…</p>
          )}
          {data && (
            <>
              {(data.sunrise || data.sunset || data.uv_max != null || data.precip_sum != null) && (
                <div
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0.5rem' }}
                  className="p-3 mb-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs"
                >
                  {data.sunrise && (
                    <span className="flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                      <Sunrise size={13} aria-hidden="true" /> {data.sunrise}
                    </span>
                  )}
                  {data.sunset && (
                    <span className="flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                      <Sunset size={13} aria-hidden="true" /> {data.sunset}
                    </span>
                  )}
                  {data.uv_max != null && (
                    <span style={{ color: 'var(--text-muted)' }}>UV max {data.uv_max}</span>
                  )}
                  {data.precip_prob_max != null && (
                    <span className="flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                      <Droplets size={13} aria-hidden="true" /> {data.precip_prob_max}%
                      {data.precip_sum ? ` · ${data.precip_sum}mm` : ''}
                    </span>
                  )}
                </div>
              )}

              <div className="space-y-0.5">
                {data.hourly.map(h => (
                  <div
                    key={h.time}
                    className="flex items-center gap-2.5 py-1.5 text-sm"
                    style={{ borderBottom: '1px solid var(--border)' }}
                  >
                    <span style={{ color: 'var(--text-faint)', width: '2.75rem' }} className="shrink-0 text-xs">
                      {h.time}
                    </span>
                    <span className="shrink-0" title={h.desc}>{h.icon}</span>
                    <span className="shrink-0 font-medium" style={{ width: '3rem' }}>
                      {Math.round(h.temp)}°C
                    </span>
                    {h.feels_like != null && h.feels_like !== h.temp && (
                      <span style={{ color: 'var(--text-faint)' }} className="text-xs shrink-0">
                        feels {Math.round(h.feels_like)}°
                      </span>
                    )}
                    <span className="flex-1" />
                    {h.precip_prob != null && h.precip_prob > 0 && (
                      <span
                        className="flex items-center gap-0.5 text-xs shrink-0"
                        style={{ color: 'var(--kind-river_transfer)' }}
                      >
                        <Droplets size={11} aria-hidden="true" /> {h.precip_prob}%
                      </span>
                    )}
                    {h.wind != null && (
                      <span
                        className="flex items-center gap-0.5 text-xs shrink-0"
                        style={{ color: 'var(--text-faint)' }}
                      >
                        <Wind size={11} aria-hidden="true" /> {Math.round(h.wind)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
