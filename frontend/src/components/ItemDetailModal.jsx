import { useEffect, useState } from 'react'
import { fetchGpxText, downloadGpx } from '../api.js'

function fmtDateTime(val) {
  if (!val) return null
  const [datePart, timePart] = val.split('T')
  const dateStr = new Date(datePart + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
  return timePart ? `${dateStr}  ${timePart}` : dateStr
}

function mapsUrl(address) {
  return `https://maps.google.com/?q=${encodeURIComponent(address)}`
}

function Row({ label, children }) {
  if (!children) return null
  return (
    <div className="flex gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-faint)', minWidth: '8rem' }} className="text-xs uppercase tracking-wide shrink-0 pt-0.5">
        {label}
      </span>
      <span style={{ color: 'var(--text)' }} className="text-sm break-words min-w-0 flex-1">{children}</span>
    </div>
  )
}

function AccommodationBody({ item }) {
  const d = item.details ?? {}
  return (
    <>
      {(d.checkin || d.checkout) && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid color-mix(in srgb, var(--kind-accommodation) 30%, transparent)',
            borderRadius: '0.5rem',
          }}
          className="p-3 mb-4 space-y-1"
        >
          {d.checkin && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Check-in</span>
              <span>{fmtDateTime(d.checkin)}</span>
            </div>
          )}
          {d.checkout && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Check-out</span>
              <span>{fmtDateTime(d.checkout)}</span>
            </div>
          )}
        </div>
      )}
      <div className="space-y-0">
        {d.location && (
          <Row label="Address">
            <a href={mapsUrl(d.location)} target="_blank" rel="noreferrer"
               style={{ color: 'var(--accent)' }} className="hover:underline">
              {d.location}
            </a>
          </Row>
        )}
        {d.contact_phone && (
          <Row label="Phone">
            <a href={`tel:${d.contact_phone}`} style={{ color: 'var(--accent)' }} className="hover:underline">
              {d.contact_phone}
            </a>
          </Row>
        )}
        {d.contact_email && (
          <Row label="Email">
            <a href={`mailto:${d.contact_email}`} style={{ color: 'var(--accent)' }} className="hover:underline">
              {d.contact_email}
            </a>
          </Row>
        )}
        {d.website && (
          <Row label="Website">
            <a href={d.website} target="_blank" rel="noreferrer"
               style={{ color: 'var(--accent)' }} className="hover:underline break-all">
              {d.website}
            </a>
          </Row>
        )}
        {d.description && <Row label="Notes">{d.description}</Row>}
      </div>

      {(d.booking_ref || item.link || item.cost || d.amount_paid) && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0.5rem' }}
          className="p-3 mt-4 space-y-1.5"
        >
          <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2 font-medium">Booking</p>
          {d.booking_ref && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Ref</span>
              {item.link
                ? <a href={item.link} target="_blank" rel="noreferrer"
                    style={{ color: 'var(--accent)' }} className="hover:underline break-all">{d.booking_ref}</a>
                : <span>{d.booking_ref}</span>
              }
            </div>
          )}
          {!d.booking_ref && item.link && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Link</span>
              <a href={item.link} target="_blank" rel="noreferrer"
                 style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
            </div>
          )}
          {item.cost && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Cost</span>
              <span>{item.cost}</span>
            </div>
          )}
          {d.amount_paid && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Paid</span>
              <span>{d.amount_paid}</span>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function ActivityBody({ item }) {
  const d = item.details ?? {}
  return (
    <div className="space-y-0">
      {item.scheduled_at && <Row label="When">{fmtDateTime(item.scheduled_at)}</Row>}
      {item.notes && <Row label="Notes">{item.notes}</Row>}
      {d.location && (
        <Row label="Address">
          <a href={mapsUrl(d.location)} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline">{d.location}</a>
        </Row>
      )}
      {d.contact_phone && (
        <Row label="Phone">
          <a href={`tel:${d.contact_phone}`} style={{ color: 'var(--accent)' }} className="hover:underline">
            {d.contact_phone}
          </a>
        </Row>
      )}
      {item.link && (
        <Row label="Website">
          <a href={item.link} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
        </Row>
      )}
      {item.cost && <Row label="Cost">{item.cost}</Row>}
    </div>
  )
}

function RestaurantBody({ item }) {
  const d = item.details ?? {}
  return (
    <>
      <div className="space-y-0">
        {(item.scheduled_at || d.reservation_time) && (
          <Row label="When">{(() => {
            if (!item.scheduled_at) return d.reservation_time
            const [dp, tp] = item.scheduled_at.split('T')
            const date = new Date(dp + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
            const t = tp?.slice(0, 5)
            return t && t !== '00:00' ? `${date}  ${t}` : date
          })()}</Row>
        )}
        {item.notes && <Row label="Notes">{item.notes}</Row>}
        {d.location && (
          <Row label="Address">
            <a href={mapsUrl(d.location)} target="_blank" rel="noreferrer"
               style={{ color: 'var(--accent)' }} className="hover:underline">
              {d.location}
            </a>
          </Row>
        )}
        {d.contact_phone && (
          <Row label="Phone">
            <a href={`tel:${d.contact_phone}`} style={{ color: 'var(--accent)' }} className="hover:underline">
              {d.contact_phone}
            </a>
          </Row>
        )}
        {item.link && (
          <Row label="Website">
            <a href={item.link} target="_blank" rel="noreferrer"
               style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
          </Row>
        )}
      </div>
      {(d.booking_status || d.booking_ref || item.cost) && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0.5rem' }}
          className="p-3 mt-4 space-y-1.5"
        >
          <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2 font-medium">Booking</p>
          {d.booking_status && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Status</span>
              <span className="capitalize">{d.booking_status}</span>
            </div>
          )}
          {d.booking_ref && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Ref</span>
              <span>{d.booking_ref}</span>
            </div>
          )}
          {item.cost && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Cost</span>
              <span>{item.cost}</span>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function NoteBody({ item }) {
  return (
    <div className="space-y-0">
      {item.scheduled_at && <Row label="When">{fmtDateTime(item.scheduled_at)}</Row>}
      {item.notes && (
        <div style={{ color: 'var(--text)', whiteSpace: 'pre-wrap' }} className="text-sm py-1">
          {item.notes}
        </div>
      )}
      {item.link && (
        <Row label="Link">
          <a href={item.link} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
        </Row>
      )}
    </div>
  )
}

function parseGpxPoints(text) {
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml')
    return Array.from(doc.querySelectorAll('trkpt')).map(pt => ({
      lat: parseFloat(pt.getAttribute('lat')),
      lon: parseFloat(pt.getAttribute('lon')),
      ele: parseFloat(pt.querySelector('ele')?.textContent ?? 'NaN'),
    })).filter(p => isFinite(p.lat) && isFinite(p.lon))
  } catch { return [] }
}

function gpxToSvgPath(pts, w, h, pad = 10) {
  if (pts.length < 2) return null
  const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon)
  const [la0, la1] = [Math.min(...lats), Math.max(...lats)]
  const [lo0, lo1] = [Math.min(...lons), Math.max(...lons)]
  const laR = la1 - la0 || 0.001, loR = lo1 - lo0 || 0.001
  const sc = Math.min((w - 2*pad) / loR, (h - 2*pad) / laR)
  const ox = (w - loR * sc) / 2, oy = (h - laR * sc) / 2
  const x = lo => ox + (lo - lo0) * sc
  const y = la => h - oy - (la - la0) * sc
  return pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.lon).toFixed(1)},${y(p.lat).toFixed(1)}`).join('')
}

function gpxToElevationPath(pts, w, h, pad = 6) {
  const ep = pts.filter(p => isFinite(p.ele))
  if (ep.length < 2) return null
  const eles = ep.map(p => p.ele)
  const [mn, mx] = [Math.min(...eles), Math.max(...eles)]
  const rng = mx - mn || 1
  const sx = (w - 2*pad) / (ep.length - 1)
  const y = e => h - pad - ((e - mn) / rng) * (h - 2*pad)
  return ep.map((p, i) => `${i ? 'L' : 'M'}${(pad + i * sx).toFixed(1)},${y(p.ele).toFixed(1)}`).join('')
}

function GpxMiniMap({ itemId }) {
  const [paths, setPaths] = useState(null)

  useEffect(() => {
    fetchGpxText(itemId).then(text => {
      if (!text) return
      const pts = parseGpxPoints(text)
      const track = gpxToSvgPath(pts, 300, 130)
      const elev  = gpxToElevationPath(pts, 300, 50)
      if (track) setPaths({ track, elev })
    })
  }, [itemId])

  if (!paths) return null

  return (
    <div style={{ borderRadius: '0.5rem', overflow: 'hidden', background: 'var(--surface-2)', margin: '0.5rem 0 0.75rem' }}>
      <svg viewBox="0 0 300 130" width="100%" style={{ display: 'block' }}>
        <path d={paths.track} fill="none" stroke="var(--kind-cycling)" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {paths.elev && (
        <svg viewBox="0 0 300 50" width="100%" style={{ display: 'block', borderTop: '1px solid var(--border)', opacity: 0.7 }}>
          <path d={paths.elev} fill="none" stroke="var(--kind-cycling)" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  )
}

function CyclingBody({ item }) {
  const d = item.details ?? {}
  return (
    <>
      {d.gpx_filename && <GpxMiniMap itemId={item.id} />}
      <div className="space-y-0">
        {(d.start_location || d.end_location) && (
          <Row label="Route">{[d.start_location, d.end_location].filter(Boolean).join(' → ')}</Row>
        )}
        {d.surface_type && <Row label="Surface"><span className="capitalize">{d.surface_type}</span></Row>}
        {(d.distance || d.elevation_gain || d.elevation_loss) && (
          <Row label="Stats">
            {[d.distance && d.distance,
              d.elevation_gain && `↑ ${d.elevation_gain}`,
              d.elevation_loss && `↓ ${d.elevation_loss}`
            ].filter(Boolean).join('  ·  ')}
          </Row>
        )}
        {item.scheduled_at && <Row label="When">{fmtDateTime(item.scheduled_at)}</Row>}
        {item.notes && <Row label="Notes">{item.notes}</Row>}
        {item.cost  && <Row label="Cost">{item.cost}</Row>}
        {d.gpx_filename && (
          <Row label="GPX">
            <button onClick={() => downloadGpx(item.id, d.original_gpx_name)}
              style={{ color: 'var(--accent)' }} className="hover:underline text-sm text-left">
              ⬇ {d.original_gpx_name || 'route.gpx'}
            </button>
          </Row>
        )}
      </div>
    </>
  )
}

const KIND_COLOR = {
  activity:      'var(--kind-activity)',
  restaurant:    'var(--kind-restaurant)',
  note:          'var(--kind-note)',
  accommodation: 'var(--kind-accommodation)',
  cycling:       'var(--kind-cycling)',
}

export default function ItemDetailModal({ item, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const kindColor = KIND_COLOR[item.kind] ?? 'var(--text-faint)'

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
          maxWidth: '32rem',
          width: '100%',
          maxHeight: '90vh',
          borderRadius: '0.75rem',
        }}
        className="overflow-y-auto"
      >
        <div
          style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}
          className="px-5 py-4 flex items-start justify-between gap-3 sticky top-0"
        >
          <div>
            <div className="font-semibold text-base">{item.name}</div>
            <div style={{ color: kindColor }} className="text-xs mt-0.5 capitalize">{item.kind}</div>
          </div>
          <button
            onClick={onClose}
            style={{ color: 'var(--text-faint)' }}
            className="text-lg leading-none hover:opacity-70 shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4">
          {item.kind === 'accommodation' && <AccommodationBody item={item} />}
          {item.kind === 'activity'      && <ActivityBody item={item} />}
          {item.kind === 'restaurant'    && <RestaurantBody item={item} />}
          {item.kind === 'note'          && <NoteBody item={item} />}
          {item.kind === 'cycling'       && <CyclingBody item={item} />}
        </div>
      </div>
    </div>
  )
}
