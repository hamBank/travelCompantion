import { describe, it, expect } from 'vitest'
import { parseKmlRoutes, routeToGpx } from '../kml.js'

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>Start point</name><Point><coordinates>2.0,48.0,0</coordinates></Point></Placemark>
  <Placemark><name>Morning ride</name>
    <LineString><coordinates>
      2.0,48.0,100 2.1,48.1,150 2.2,48.2,120
    </coordinates></LineString>
  </Placemark>
</Document></kml>`

describe('parseKmlRoutes', () => {
  it('extracts LineString routes and ignores Point placemarks', () => {
    const routes = parseKmlRoutes(KML)
    expect(routes).toHaveLength(1)
    expect(routes[0].name).toBe('Morning ride')
    expect(routes[0].points).toHaveLength(3)
    // KML is lon,lat,ele — parser must swap to {lat, lon, ele}
    expect(routes[0].points[0]).toEqual({ lat: 48.0, lon: 2.0, ele: 100 })
  })

  it('throws on unparseable input', () => {
    expect(() => parseKmlRoutes('<<<not kml')).toThrow()
  })
})

describe('routeToGpx', () => {
  it('emits a GPX track with escaped name and trkpts', () => {
    const gpx = routeToGpx('Tom & Jerry', [{ lat: 48, lon: 2, ele: 100 }])
    expect(gpx).toContain('<gpx')
    expect(gpx).toContain('<trkpt lat="48" lon="2">')
    expect(gpx).toContain('<ele>100</ele>')
    expect(gpx).toContain('Tom &amp; Jerry')
  })
})
