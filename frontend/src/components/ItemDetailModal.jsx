import { useEffect, useState, useRef } from 'react'
import {
  fetchGpxText, downloadGpx, fetchRiverMapBlob,
  listAttachments, uploadAttachment, deleteAttachment, fetchAttachmentBlob,
} from '../api.js'
import CostDisplay from './CostDisplay.jsx'
import DetailActions from './DetailActions.jsx'
import ItemHistoryModal from './ItemHistoryModal.jsx'
import PassengersTable from './PassengersTable.jsx'
import RichText from './RichText.jsx'
import CopyText from './CopyText.jsx'
import { relevantDayIndices, filterHoursByDays } from '../washHours.js'
import { registerModal, unregisterModal } from '../modalNav.js'
import { useSwipeNav } from '../swipeNav.js'
import { fmtDayTime, fmtDay } from '../dates.js'
import { useCanEdit } from '../roles.js'

const fmtDateTime = fmtDayTime

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
      <span style={{ color: 'var(--text)' }} className="text-sm break-words min-w-0 flex-1">
        {typeof children === 'string'
          ? <CopyText value={children}><RichText>{children}</RichText></CopyText>
          : children}
      </span>
    </div>
  )
}

function AccommodationBody({ item }) {
  const d = item.details ?? {}
  return (
    <>
      {(d.bag_drop || d.checkin || d.checkout) && (
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid color-mix(in srgb, var(--kind-accommodation) 30%, transparent)',
            borderRadius: '0.5rem',
          }}
          className="p-3 mb-4 space-y-1"
        >
          {d.bag_drop && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Bag drop</span>
              <span>{fmtDateTime(d.bag_drop)}</span>
            </div>
          )}
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
        {d.description && <Row label="Description">{d.description}</Row>}
      </div>

      {(d.booking_ref || item.link || item.cost) && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0.5rem' }}
          className="p-3 mt-4 space-y-1.5"
        >
          <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2 font-medium">Booking</p>
          {d.booking_ref && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Ref</span>
              {item.link
                ? <span className="flex items-center gap-1.5 min-w-0">
                    <a href={item.link} target="_blank" rel="noreferrer"
                      style={{ color: 'var(--accent)' }} className="hover:underline break-all">{d.booking_ref}</a>
                    {/* The ref doubles as a link here, so clicking it navigates —
                        give copy its own affordance instead. */}
                    <CopyText value={d.booking_ref}><span title="Copy booking ref">⧉</span></CopyText>
                  </span>
                : <CopyText value={d.booking_ref}>{d.booking_ref}</CopyText>
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
              <CostDisplay item={item} showIcon={false} />
            </div>
          )}
        </div>
      )}

      {/* Laundry */}
      {(d.hotel_laundry || (Array.isArray(d.washing) && d.washing.length > 0)) && (
        <div className="mt-4">
          <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-1 font-medium">
            Laundry
          </p>
          {d.hotel_laundry && (
            <div style={{ color: 'var(--success)' }} className="text-xs mb-1">✓ Hotel offers laundry service</div>
          )}
          {Array.isArray(d.washing) && (() => {
            const rdays = relevantDayIndices(d.checkin || item.scheduled_at, d.checkout)
            return d.washing.map((e, i) => <WashingEntry key={i} e={e} relevantDays={rdays} />)
          })()}
        </div>
      )}
    </>
  )
}

function WashingEntry({ e, relevantDays }) {
  const chips = [
    e.open_24hrs && '24hr',
    e.cash_card,
    e.detergent_included === true && 'Detergent ✓',
    e.detergent_included === false && 'No detergent',
  ].filter(Boolean)
  return (
    <div className="py-2" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        {e.top_pick && (
          <span style={{ background: 'var(--success)', color: '#fff', fontSize: '0.65rem' }}
                className="px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide shrink-0">
            Top pick
          </span>
        )}
        <span className="font-medium text-sm">{e.name}</span>
        {e.rating != null && (
          <span style={{ color: 'var(--warning)' }} className="text-xs">★ {e.rating.toFixed(1)}
            {e.review_count != null && <span style={{ color: 'var(--text-faint)' }}> ({e.review_count})</span>}
          </span>
        )}
        {e.distance_m != null && (
          <span style={{ color: 'var(--text-faint)' }} className="text-xs ml-auto shrink-0">
            {e.distance_m < 1000 ? `${e.distance_m}m` : `${(e.distance_m/1000).toFixed(1)}km`}
          </span>
        )}
      </div>
      {e.address && <div style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5">{e.address}</div>}
      {(() => {
        const filtered = filterHoursByDays(e.hours, relevantDays)
        if (!filtered) return null
        const lines = Array.isArray(filtered) ? filtered : [filtered]
        return lines.map((line, i) => (
          <div key={i} style={{ color: 'var(--text-muted)' }} className="text-xs mt-0.5">{line}</div>
        ))
      })()}
      {chips.length > 0 && (
        <div className="flex gap-1 flex-wrap mt-1">
          {chips.map((c, i) => (
            <span key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: '0.65rem' }}
                  className="px-1.5 py-0.5 rounded" style={{ color: 'var(--text-muted)', border: '1px solid var(--border)', fontSize: '0.65rem' }}>
              {c}
            </span>
          ))}
        </div>
      )}
      {e.key_notes && <div style={{ color: 'var(--text-muted)' }} className="text-xs mt-0.5 italic">{e.key_notes}</div>}
      {e.warnings && <div style={{ color: 'var(--error)' }} className="text-xs mt-0.5">⚠ {e.warnings}</div>}
    </div>
  )
}

function ActivityBody({ item }) {
  const d = item.details ?? {}
  return (
    <div className="space-y-0">
      {item.scheduled_at && <Row label="When">{fmtDateTime(item.scheduled_at)}</Row>}
      {d.duration && <Row label="Duration">{d.duration}</Row>}
      {d.description && <Row label="Description">{d.description}</Row>}
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
      {item.cost && <Row label="Cost"><CostDisplay item={item} /></Row>}
    </div>
  )
}

function ShowBody({ item }) {
  const d = item.details ?? {}
  return (
    <div className="space-y-0">
      {item.scheduled_at && <Row label="Start time">{fmtDateTime(item.scheduled_at)}</Row>}
      {d.duration && <Row label="Doors / duration">{d.duration}</Row>}
      {d.location && (
        <Row label="Venue">
          <a href={mapsUrl(d.location)} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline">{d.location}</a>
        </Row>
      )}
      {d.booking_ref && <Row label="Booking ref">{d.booking_ref}</Row>}
      {d.description && <Row label="Description">{d.description}</Row>}
      {d.contact_phone && (
        <Row label="Phone">
          <a href={`tel:${d.contact_phone}`} style={{ color: 'var(--accent)' }} className="hover:underline">
            {d.contact_phone}
          </a>
        </Row>
      )}
      {item.link && (
        <Row label="Tickets URL">
          <a href={item.link} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
        </Row>
      )}
      {item.cost && <Row label="Cost"><CostDisplay item={item} /></Row>}
      <PassengersTable passengers={d.participants} label="Participants" />
    </div>
  )
}

function RestaurantBody({ item }) {
  const d = item.details ?? {}
  return (
    <>
      <div className="space-y-0">
        {(item.scheduled_at || d.reservation_time) && (
          <Row label="When">{item.scheduled_at ? fmtDayTime(item.scheduled_at) : d.reservation_time}</Row>
        )}
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
              <CopyText value={d.booking_ref}>{d.booking_ref}</CopyText>
            </div>
          )}
          {item.cost && (
            <div className="flex justify-between gap-4 text-sm">
              <span style={{ color: 'var(--text-faint)' }}>Cost</span>
              <CostDisplay item={item} showIcon={false} />
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
        <div style={{ color: 'var(--text)' }} className="text-sm py-1">
          <RichText>{item.notes}</RichText>
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

async function fetchOpenTopoElevations(samples) {
  try {
    const r = await fetch('https://api.opentopodata.org/v1/srtm90m', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: samples.map(s => `${s.lat},${s.lon}`).join('|') }),
    })
    if (!r.ok) return null
    const data = await r.json()
    return data.results?.map(res => res.elevation) ?? null
  } catch { return null }
}

async function enrichElevation(pts) {
  if (pts.some(p => isFinite(p.ele))) return pts  // already has elevation

  const MAX = 100
  const n = pts.length
  const stride = Math.max(1, Math.floor(n / (MAX - 1)))
  const idxs = []
  for (let i = 0; i < n && idxs.length < MAX - 1; i += stride) idxs.push(i)
  if (idxs[idxs.length - 1] !== n - 1) idxs.push(n - 1)

  const eles = await fetchOpenTopoElevations(idxs.map(i => pts[i]))
  if (!eles) return pts

  const eleAt = {}
  idxs.forEach((idx, j) => { if (eles[j] != null) eleAt[idx] = eles[j] })
  const keys = Object.keys(eleAt).map(Number).sort((a, b) => a - b)
  if (!keys.length) return pts

  const all = new Array(n).fill(NaN)
  for (let i = 0; i < keys[0]; i++) all[i] = eleAt[keys[0]]
  for (let ki = 0; ki < keys.length - 1; ki++) {
    const i0 = keys[ki], i1 = keys[ki + 1], e0 = eleAt[i0], e1 = eleAt[i1]
    for (let i = i0; i <= i1; i++) all[i] = e0 + (e1 - e0) * (i - i0) / (i1 - i0)
  }
  return pts.map((p, i) => ({ ...p, ele: all[i] }))
}

const TILE = 256
function lonToTX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z) }
function latToTY(lat, z) {
  const r = lat * Math.PI / 180
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)
}

function GpxMapCanvas({ pts }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!pts || pts.length < 2 || !ref.current) return
    const canvas = ref.current
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height

    const lats = pts.map(p => p.lat), lons = pts.map(p => p.lon)
    const la0 = Math.min(...lats), la1 = Math.max(...lats)
    const lo0 = Math.min(...lons), lo1 = Math.max(...lons)
    const laP = (la1 - la0) * 0.2 || 0.005
    const loP = (lo1 - lo0) * 0.2 || 0.005
    const bLaC = (la0 + la1) / 2, bLoC = (lo0 + lo1) / 2

    // pick zoom where route spans ~70% of canvas
    let zoom = 15
    for (let z = 15; z >= 1; z--) {
      const sx = (lonToTX(lo1 + loP, z) - lonToTX(lo0 - loP, z)) * TILE
      const sy = (latToTY(la0 - laP, z) - latToTY(la1 + laP, z)) * TILE
      if (sx <= W * 0.9 && sy <= H * 0.9) { zoom = z; break }
    }

    const cTX = lonToTX(bLoC, zoom), cTY = latToTY(bLaC, zoom)
    const originTX = cTX - W / (2 * TILE), originTY = cTY - H / (2 * TILE)
    const toPixel = (lat, lon) => ({
      x: (lonToTX(lon, zoom) - originTX) * TILE,
      y: (latToTY(lat, zoom) - originTY) * TILE,
    })

    const tX0 = Math.floor(originTX), tX1 = Math.ceil(originTX + W / TILE)
    const tY0 = Math.floor(originTY), tY1 = Math.ceil(originTY + H / TILE)
    const maxT = Math.pow(2, zoom)
    const loads = []
    for (let tx = tX0; tx <= tX1; tx++) {
      for (let ty = tY0; ty <= tY1; ty++) {
        if (ty < 0 || ty >= maxT) continue
        const wtx = ((tx % maxT) + maxT) % maxT
        const px = (tx - originTX) * TILE, py = (ty - originTY) * TILE
        loads.push(new Promise(res => {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => { ctx.drawImage(img, px, py, TILE, TILE); res() }
          img.onerror = () => res()
          img.src = `https://tile.openstreetmap.org/${zoom}/${wtx}/${ty}.png`
        }))
      }
    }

    Promise.all(loads).then(() => {
      // dark overlay so track pops
      ctx.fillStyle = 'rgba(0,0,0,0.08)'
      ctx.fillRect(0, 0, W, H)

      const px = pts.map(p => toPixel(p.lat, p.lon))

      // shadow
      ctx.beginPath()
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 5
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      px.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))
      ctx.stroke()

      // track
      ctx.beginPath()
      ctx.strokeStyle = '#fb923c'
      ctx.lineWidth = 3
      px.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))
      ctx.stroke()

      // start dot (green)
      ctx.beginPath(); ctx.fillStyle = '#4ade80'
      ctx.arc(px[0].x, px[0].y, 5, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke()

      // end dot (red)
      ctx.beginPath(); ctx.fillStyle = '#f87171'
      ctx.arc(px[px.length-1].x, px[px.length-1].y, 5, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke()

      // attribution
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.fillRect(0, H - 13, W, 13)
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.font = '8px sans-serif'
      ctx.fillText('© OpenStreetMap contributors', 3, H - 3)
    })
  }, [pts])

  return <canvas ref={ref} width={480} height={210} style={{ width: '100%', display: 'block' }} />
}

function ElevationChart({ pts }) {
  const ep = pts.filter(p => isFinite(p.ele))
  if (ep.length < 2) return null
  const W = 300, H = 64, padX = 2, padY = 6
  const eles = ep.map(p => p.ele)
  const mn = Math.min(...eles), mx = Math.max(...eles)
  const rng = mx - mn || 1
  const sx = (W - 2 * padX) / (ep.length - 1)
  const yFn = e => H - padY - ((e - mn) / rng) * (H - 2 * padY)
  const coords = ep.map((p, i) => `${(padX + i * sx).toFixed(1)},${yFn(p.ele).toFixed(1)}`)
  const line = coords.map((c, i) => `${i ? 'L' : 'M'}${c}`).join('')
  const last = coords[coords.length - 1].split(',')
  const area = `${line}L${last[0]},${H}L${padX},${H}Z`
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
        <defs>
          <linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--kind-cycling)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--kind-cycling)" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#elevGrad)" />
        <path d={line} fill="none" stroke="var(--kind-cycling)" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 6px 6px', color: 'var(--text-faint)', fontSize: '0.65rem' }}>
        <span>↓ {Math.round(mn)} m</span>
        <span style={{ color: 'var(--text-muted)' }}>Elevation</span>
        <span>↑ {Math.round(mx)} m</span>
      </div>
    </div>
  )
}

function GpxMiniMap({ itemId }) {
  const [pts, setPts] = useState(null)

  useEffect(() => {
    fetchGpxText(itemId).then(async text => {
      if (!text) return
      const raw = parseGpxPoints(text)
      if (raw.length < 2) return
      const enriched = await enrichElevation(raw)
      setPts(enriched)
    })
  }, [itemId])

  if (!pts) return null

  return (
    <div style={{ borderRadius: '0.5rem', overflow: 'hidden', border: '1px solid var(--border)', margin: '0 0 1rem' }}>
      <GpxMapCanvas pts={pts} />
      <ElevationChart pts={pts} />
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
          {item.cost  && <Row label="Cost"><CostDisplay item={item} showIcon={false} /></Row>}
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

function HireBody({ item }) {
  const d = item.details ?? {}
  const VEHICLE_ICON = { car: '🚗', bike: '🚲', scooter: '🛵', van: '🚐', motorcycle: '🏍' }
  const icon = VEHICLE_ICON[d.vehicle_type?.toLowerCase()] ?? '🚗'
  return (
    <div className="space-y-0">
      {d.vehicle_type && <Row label="Vehicle">{icon} <span className="capitalize">{d.vehicle_type}</span></Row>}
      {d.provider && <Row label="Provider">{d.provider}</Row>}
      {d.pickup_location && (
        <Row label="Pick-up">
          <a href={mapsUrl(d.pickup_location)} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline">{d.pickup_location}</a>
        </Row>
      )}
      {d.pickup_time && <Row label="Pick-up time">{fmtDateTime(d.pickup_time)}</Row>}
      {d.dropoff_location && (
        <Row label="Drop-off">
          <a href={mapsUrl(d.dropoff_location)} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline">{d.dropoff_location}</a>
        </Row>
      )}
      {d.dropoff_time && <Row label="Drop-off time">{fmtDateTime(d.dropoff_time)}</Row>}
      {d.booking_ref && <Row label="Booking ref">{d.booking_ref}</Row>}
      {item.link && (
        <Row label="Link">
          <a href={item.link} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
        </Row>
      )}
      {item.cost && <Row label="Cost"><CostDisplay item={item} /></Row>}
      {d.description && <Row label="Notes">{d.description}</Row>}
    </div>
  )
}

function RiverMiniMap({ itemId }) {
  const [mapUrl, setMapUrl] = useState(null)

  useEffect(() => {
    let objectUrl = null
    let cancelled = false
    fetchRiverMapBlob(itemId).then(blob => {
      if (cancelled || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setMapUrl(objectUrl)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [itemId])

  if (!mapUrl) return null

  return (
    <div style={{ borderRadius: '0.5rem', overflow: 'hidden', border: '1px solid var(--border)', margin: '0 0 1rem' }}>
      <img src={mapUrl} alt="Assumed river path" style={{ display: 'block', width: '100%', height: 'auto' }} />
    </div>
  )
}

const RIVER_VEHICLE_ICON = { ferry: '⛴', boat: '🚤', riverboat: '🛶', 'water taxi': '🚤' }

function RiverTransferBody({ item }) {
  const d = item.details ?? {}
  const hasPath = d.river_path?.length >= 2
  const icon = RIVER_VEHICLE_ICON[d.vehicle_type?.toLowerCase()] ?? '⛴'
  return (
    <div className="space-y-0">
      {hasPath && <RiverMiniMap itemId={item.id} />}
      {hasPath && d.river_path_approximate && (
        <p style={{ color: 'var(--warning)' }} className="text-xs mb-3">
          ⚠ No detected waterway route — showing a straight line between the two points.
        </p>
      )}
      {(d.start_location || d.end_location) && (
        <Row label="Route">{[d.start_location, d.end_location].filter(Boolean).join(' → ')}</Row>
      )}
      {d.vehicle_type && <Row label="Vessel">{icon} <span className="capitalize">{d.vehicle_type}</span></Row>}
      {d.depart_time && <Row label="Departs">{fmtDateTime(d.depart_time)}</Row>}
      {d.arrive_time && <Row label="Arrives">{fmtDateTime(d.arrive_time)}</Row>}
      {(d.distance || d.duration) && (
        <Row label="Stats">{[d.distance, d.duration].filter(Boolean).join('  ·  ')}</Row>
      )}
      {d.provider && <Row label="Provider">{d.provider}</Row>}
      {d.booking_ref && <Row label="Booking ref">{d.booking_ref}</Row>}
      {d.contact_phone && <Row label="Phone">{d.contact_phone}</Row>}
      {d.cost_per_person && <Row label="Per person">{d.cost_per_person}</Row>}
      {item.cost && <Row label="Cost"><CostDisplay item={item} /></Row>}
    </div>
  )
}

function formatAttachmentSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function AttachmentsSection({ itemId }) {
  const [attachments, setAttachments] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [preview, setPreview] = useState(null)   // { id, url } — inline image preview
  const fileInputRef = useRef(null)
  const canEdit = useCanEdit()

  function refresh() {
    return listAttachments(itemId)
      .then(setAttachments)
      .catch(e => setError(e.message))
      .finally(() => setLoaded(true))
  }

  useEffect(() => { refresh() }, [itemId])

  // Revoke the previous preview's object URL whenever it changes or the
  // section unmounts, so opening several images in a row doesn't leak them.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url) }, [preview])

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true); setError(null)
    try {
      await uploadAttachment(itemId, file)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  async function handleOpen(att) {
    setError(null)
    if (preview?.id === att.id) { setPreview(null); return }   // toggle closed
    const blob = await fetchAttachmentBlob(att.id)
    if (!blob) { setError('Could not load attachment'); return }
    const url = URL.createObjectURL(blob)
    if ((att.content_type || '').startsWith('image/')) {
      setPreview({ id: att.id, url })
    } else {
      window.open(url, '_blank', 'noopener')
    }
  }

  async function handleDelete(id) {
    setError(null)
    try {
      await deleteAttachment(id)
      setAttachments(prev => prev.filter(a => a.id !== id))
      if (preview?.id === id) setPreview(null)
    } catch (err) {
      setError(err.message)
    }
  }

  if (!loaded) return null
  if (!attachments.length && !canEdit) return null

  return (
    <div className="mt-4" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2 font-medium">
        Attachments
      </p>
      {attachments.map(att => (
        <div key={att.id} className="flex items-center gap-2 py-1">
          <button
            onClick={() => handleOpen(att)}
            style={{ color: 'var(--accent)' }}
            className="hover:underline text-left text-sm flex-1 min-w-0 truncate"
          >
            📎 {att.filename}
          </button>
          <span style={{ color: 'var(--text-faint)' }} className="text-xs shrink-0">
            {formatAttachmentSize(att.size)}
          </span>
          {canEdit && (
            <button
              onClick={() => handleDelete(att.id)}
              style={{ color: 'var(--text-faint)' }}
              className="text-xs hover:opacity-70 shrink-0"
              title="Delete attachment"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      {preview && (
        <div className="mt-2">
          <img
            src={preview.url}
            alt="Attachment preview"
            style={{ maxWidth: '100%', borderRadius: '0.5rem', border: '1px solid var(--border)', display: 'block' }}
          />
        </div>
      )}
      {error && <div style={{ color: 'var(--error)' }} className="text-xs mt-1">{error}</div>}
      {canEdit && (
        <div className="mt-2">
          <input ref={fileInputRef} type="file" onChange={handleFileChange} style={{ display: 'none' }} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{ color: 'var(--accent)' }}
            className="text-sm hover:underline disabled:opacity-50"
          >
            {uploading ? 'Uploading…' : '+ Add attachment'}
          </button>
        </div>
      )}
    </div>
  )
}

const KIND_COLOR = {
  activity:      'var(--kind-activity)',
  restaurant:    'var(--kind-restaurant)',
  note:          'var(--kind-note)',
  accommodation: 'var(--kind-accommodation)',
  cycling:       'var(--kind-cycling)',
  hire:          'var(--kind-hire)',
  river_transfer:'var(--kind-river_transfer)',
}

export default function ItemDetailModal({ item, onClose, onEdit, onDeleted, isNavModal = false }) {
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    registerModal(item.id, onClose)
    return () => unregisterModal()
  }, [item.id, onClose])

  // mobile: swipe left/right = next/prev (mirrors j/k)
  useSwipeNav(direction => window.dispatchEvent(new CustomEvent('modalNav', { detail: { itemId: item.id, direction } })))

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'j' || e.key === 'k')
        window.dispatchEvent(new CustomEvent('modalNav', { detail: { itemId: item.id, direction: e.key === 'j' ? 'next' : 'prev' } }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, item.id])

  const kindColor = KIND_COLOR[item.kind] ?? 'var(--text-faint)'

  return (
    <>
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
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              <span style={{ color: kindColor }} className="text-xs capitalize">{item.kind}</span>
              {item.details?.needs_booking && (
                <span
                  style={{
                    color: 'var(--warning)',
                    border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
                    fontSize: '0.6rem',
                  }}
                  className="shrink-0 px-1.5 py-0.5 rounded uppercase tracking-wide font-medium"
                >
                  Needs booking{item.details.book_by ? ` · book by ${fmtDay(item.details.book_by)}` : ''}
                </span>
              )}
            </div>
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
          {item.kind === 'show'          && <ShowBody item={item} />}
          {item.kind === 'restaurant'    && <RestaurantBody item={item} />}
          {item.kind === 'note'          && <NoteBody item={item} />}
          {item.kind === 'cycling'       && <CyclingBody item={item} />}
          {item.kind === 'hire'          && <HireBody item={item} />}
          {item.kind === 'river_transfer' && <RiverTransferBody item={item} />}
          {/* Notes apply to every kind — shown only when filled (note items show it as their body). */}
          {item.kind !== 'note' && item.notes && <Row label="Notes">{item.notes}</Row>}
          <AttachmentsSection itemId={item.id} />
        </div>

        <DetailActions item={item} onEdit={onEdit} onDeleted={onDeleted} onClose={onClose}
                       onHistory={() => setShowHistory(true)} />
      </div>
    </div>
    {showHistory && <ItemHistoryModal item={item} onClose={() => setShowHistory(false)} />}
    </>
  )
}
