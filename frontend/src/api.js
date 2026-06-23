function getToken() { return localStorage.getItem('tc-token') }

async function req(path, opts = {}) {
  const token = getToken()
  const r = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...opts,
  })
  if (r.status === 204) return null
  const text = await r.text()
  if (!text) return null
  let body
  try { body = JSON.parse(text) }
  catch { throw new Error(`Server error ${r.status}`) }
  if (!r.ok) throw new Error(
    Array.isArray(body.detail)
      ? body.detail.map(e => e.msg).join('; ')
      : (body.detail ?? r.statusText)
  )
  return body
}

export const getAuthConfig  = ()       => req('/auth/config')
export const loginWithGoogle = (credential) =>
  req('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) })

export const getTrips   = () => req('/trips/')
export const deleteTrip = (id) => req(`/trips/${id}`, { method: 'DELETE' })
export const updateTrip = (id, data) =>
  req(`/trips/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const getTripTimeline = (id) => req(`/trips/${id}/timeline`)
export const getDateWarnings = (id) => req(`/trips/${id}/date-warnings`)

export const getTripMembers = (id) => req(`/trips/${id}/members`)
export const addTripMember = (id, user_email, role) =>
  req(`/trips/${id}/members`, { method: 'POST', body: JSON.stringify({ user_email, role }) })
export const removeTripMember = (id, email) =>
  req(`/trips/${id}/members/${encodeURIComponent(email)}`, { method: 'DELETE' })

export const backfillAccommodations = (tripId) =>
  req(`/import/backfill-accommodations/${tripId}`, { method: 'POST' })

export const importFromSheets = (trip_name) =>
  req('/import/sheets', { method: 'POST', body: JSON.stringify({ trip_name }) })

export const createStop = (tripId, data) =>
  req(`/trips/${tripId}/stops`, { method: 'POST', body: JSON.stringify(data) })
export const updateStop = (id, data) =>
  req(`/stops/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const deleteStop = (id) => req(`/stops/${id}`, { method: 'DELETE' })

export const createItem = (stopId, data) =>
  req(`/stops/${stopId}/items`, { method: 'POST', body: JSON.stringify(data) })
export const updateItem = (id, data) =>
  req(`/items/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const deleteItem = (id) => req(`/items/${id}`, { method: 'DELETE' })

export const getItemStops = (id) => req(`/items/${id}/sibling-stops`)
export const moveItem = (id, stopId) =>
  req(`/items/${id}/move`, { method: 'POST', body: JSON.stringify({ stop_id: stopId }) })

export const updateItemStatus = (id, status) => updateItem(id, { status })
export const updateStopStatus = (id, status) => updateStop(id, { status })

export const enrichItem    = (id)   => req(`/items/${id}/enrich`)
export const checkFlight   = (id)   => req(`/items/${id}/flight-check`)
export const checkRail     = (id)   => req(`/items/${id}/rail-check`)
export const lookupAirline = (iata) => req(`/flights/airline-lookup?iata=${encodeURIComponent(iata)}`)

export const fetchRouteElevation = (lat1, lng1, lat2, lng2) =>
  req(`/route-elevation?lat1=${lat1}&lng1=${lng1}&lat2=${lat2}&lng2=${lng2}`)

export const fetchGeocode = (q) =>
  req(`/geocode?q=${encodeURIComponent(q)}`)

export const routeDistance = (points, mode) =>
  req('/route-distance', { method: 'POST', body: JSON.stringify({ points, mode }) })

export async function uploadGpx(id, file) {
  const token = getToken()
  const form = new FormData()
  form.append('file', file)
  const r = await fetch(`/items/${id}/gpx`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  const body = await r.json()
  if (!r.ok) throw new Error(Array.isArray(body.detail) ? body.detail.map(e => e.msg).join('; ') : (body.detail ?? r.statusText))
  return body
}

export async function parseDocument(tripId, file) {
  const token = getToken()
  const form = new FormData()
  form.append('file', file)
  const r = await fetch(`/trips/${tripId}/parse-document`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`Server error ${r.status}`) }
  if (!r.ok) throw new Error(Array.isArray(body.detail) ? body.detail.map(e => e.msg).join('; ') : (body.detail ?? r.statusText))
  return body
}

export async function downloadGpx(id, filename) {
  const token = getToken()
  const r = await fetch(`/items/${id}/gpx`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!r.ok) throw new Error('Download failed')
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename || 'route.gpx'
  document.body.appendChild(a); a.click()
  document.body.removeChild(a); URL.revokeObjectURL(url)
}

export async function fetchGpxText(id) {
  const token = getToken()
  const r = await fetch(`/items/${id}/gpx`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return r.ok ? r.text() : null
}
