// Parse Google "My Maps" KML exports. Routes are LineString (or gx:Track)
// placemarks; points are Point placemarks (ignored here — we only want routes).

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ))
}

/**
 * Extract route geometries from a KML string.
 * Returns [{ name, points: [{ lat, lon, ele? }] }] for each LineString / gx:Track.
 * KML coordinates are lon,lat,alt order.
 */
export function parseKmlRoutes(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not parse KML file')

  const routes = []
  for (const pm of Array.from(doc.getElementsByTagName('Placemark'))) {
    const name = pm.getElementsByTagName('name')[0]?.textContent?.trim() || 'Route'
    let points = []

    const ls = pm.getElementsByTagName('LineString')[0]
    if (ls) {
      const raw = ls.getElementsByTagName('coordinates')[0]?.textContent ?? ''
      points = raw.trim().split(/\s+/).map(tok => {
        const [lon, lat, ele] = tok.split(',').map(Number)
        return { lat, lon, ele: Number.isFinite(ele) ? ele : undefined }
      })
    } else {
      // gx:Track fallback: <gx:coord>lon lat ele</gx:coord> repeated
      const coords = Array.from(pm.getElementsByTagName('gx:coord'))
      if (coords.length) {
        points = coords.map(c => {
          const [lon, lat, ele] = c.textContent.trim().split(/\s+/).map(Number)
          return { lat, lon, ele: Number.isFinite(ele) ? ele : undefined }
        })
      }
    }

    points = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    if (points.length >= 2) routes.push({ name, points })
  }
  return routes
}

/** Convert a parsed route into a minimal GPX 1.1 track. */
export function routeToGpx(name, points) {
  const trkpts = points.map(p =>
    `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele != null ? `<ele>${p.ele}</ele>` : ''}</trkpt>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TravelCompanion" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${escapeXml(name)}</name><trkseg>${trkpts}</trkseg></trk>
</gpx>`
}
