function getToken() { return localStorage.getItem('tc-token') }

async function req(path, opts = {}) {
  const token = getToken()
  const r = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
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

// ── Packing list ─────────────────────────────────────────────────────────────
export const getPacking       = (tripId)        => req(`/trips/${tripId}/packing`)
export const createPackItem   = (tripId, data)  => req(`/trips/${tripId}/packing`, { method: 'POST', body: JSON.stringify(data) })
export const updatePackItem   = (id, data)      => req(`/packing/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const deletePackItem   = (id)            => req(`/packing/${id}`, { method: 'DELETE' })
export const createBag        = (tripId, data)  => req(`/trips/${tripId}/bags`, { method: 'POST', body: JSON.stringify(typeof data === 'string' ? { name: data } : data) })
export const updateBag        = (id, data)      => req(`/bags/${id}`, { method: 'PATCH', body: JSON.stringify(typeof data === 'string' ? { name: data } : data) })
export const deleteBag        = (id)            => req(`/bags/${id}`, { method: 'DELETE' })

// ── Push notifications ──────────────────────────────────────────────────────
export const getVapidPublicKey = () => req('/push/vapid-public-key')
export const subscribePush     = (data) => req('/push/subscribe', { method: 'POST', body: JSON.stringify(data) })
export const unsubscribePush   = (endpoint) => req(`/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`, { method: 'DELETE' })

export const getWeather = (lat, lng, start, end, q) => {
  const p = new URLSearchParams({ start, end })
  if (lat) p.set('lat', lat)
  if (lng) p.set('lng', lng)
  if (q) p.set('q', q)
  return req(`/weather?${p.toString()}`)
}

export const getTripTimeline = (id, opts = {}) => {
  const params = new URLSearchParams(opts)
  const qs = params.toString() ? '?' + params.toString() : ''
  return req(`/trips/${id}/timeline${qs}`)
}
export const getDateWarnings = (id) => req(`/trips/${id}/date-warnings`)

// ── Pending changes (review-before-apply imports) ────────────────────────────
export const getPending     = (tripId) => req(`/pending${tripId != null ? `?trip_id=${tripId}` : ''}`)
export const updatePending  = (id, data) => req(`/pending/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const applyPending   = (id) => req(`/pending/${id}/apply`, { method: 'POST' })
export const discardPending = (id) => req(`/pending/${id}/discard`, { method: 'POST' })
export const getImportAddress  = () => req('/me/import-address')
export const getIngestedEmail  = (id) => req(`/me/emails/${id}`)

export async function downloadIngestedEmail(id) {
  const token = getToken()
  const r = await fetch(`/me/emails/${id}/raw`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!r.ok) throw new Error('Download failed')
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `email-${id}.eml`
  document.body.appendChild(a); a.click()
  document.body.removeChild(a); URL.revokeObjectURL(url)
}

export async function exportTripPdf(id, name) {
  const token = getToken()
  const r = await fetch(`/trips/${id}/export.pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!r.ok) throw new Error('PDF export failed')
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(name || 'trip').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'trip'}.pdf`
  document.body.appendChild(a); a.click()
  document.body.removeChild(a); URL.revokeObjectURL(url)
}

export const getCalendarUrl = (id) => req(`/trips/${id}/calendar-url`)

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

export const getItemHistory = (id) => req(`/items/${id}/history`)
export const getItemStops = (id) => req(`/items/${id}/sibling-stops`)
export const getBookingPrimary = (id) => req(`/items/${id}/booking-primary`)
export const moveItem = (id, stopId) =>
  req(`/items/${id}/move`, { method: 'POST', body: JSON.stringify({ stop_id: stopId }) })

export const updateItemStatus = (id, status) => updateItem(id, { status })
export const updateStopStatus = (id, status) => updateStop(id, { status })

export const enrichPlace   = (stopId, { kind, name, location = '' }) =>
  req(`/stops/${stopId}/enrich?${new URLSearchParams({ kind, name, ...(location ? { location } : {}) })}`)
export const washLookup    = (id, address = '') => req(
  `/items/${id}/wash-lookup${address ? '?address=' + encodeURIComponent(address) : ''}`,
  { method: 'POST' }
)
export const checkFlight   = (id)   => req(`/items/${id}/flight-check`)
export const checkRail     = (id)   => req(`/items/${id}/rail-check`)
export const lookupAirline = (iata) => req(`/flights/airline-lookup?iata=${encodeURIComponent(iata)}`)

export const fetchRouteElevation = (lat1, lng1, lat2, lng2) =>
  req(`/route-elevation?lat1=${lat1}&lng1=${lng1}&lat2=${lat2}&lng2=${lng2}`)

export const fetchGeocode = (q) =>
  req(`/geocode?q=${encodeURIComponent(q)}`)

export const routeDistance = (points, mode) =>
  req('/route-distance', { method: 'POST', body: JSON.stringify({ points, mode }) })

export const routeToGpx = (id, points, mode) =>
  req(`/items/${id}/route-gpx`, { method: 'POST', body: JSON.stringify({ points, mode }) })

export const generateRiverPath = (points, riverName) =>
  req('/river-path', { method: 'POST', body: JSON.stringify({ points, river_name: riverName || null }) })

export async function fetchRiverMapBlob(id) {
  const token = getToken()
  const r = await fetch(`/items/${id}/river-map`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return r.ok ? r.blob() : null
}

export async function fetchGpxMapBlob(id) {
  const token = getToken()
  const r = await fetch(`/items/${id}/gpx-map`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return r.ok ? r.blob() : null
}

export async function fetchDayMapBlob(stopId, locations) {
  const token = getToken()
  const r = await fetch(`/stops/${stopId}/day-map`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ locations }),
  })
  return r.ok ? r.blob() : null
}

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

export async function parseDocument(tripId, files, { force = false } = {}) {
  const token = getToken()
  const form = new FormData()
  const fileList = Array.isArray(files) ? files : [files]
  for (const f of fileList) form.append('files', f)
  const url = `/trips/${tripId}/parse-document` + (force ? '?force=true' : '')
  const r = await fetch(url, {
    method:  'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body:    form,
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

// ── Item attachments (boarding passes, booking PDFs, QR codes) ──────────────

export async function uploadAttachment(itemId, file) {
  const token = getToken()
  const form = new FormData()
  form.append('file', file)
  const r = await fetch(`/items/${itemId}/attachments`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  const body = await r.json()
  if (!r.ok) throw new Error(Array.isArray(body.detail) ? body.detail.map(e => e.msg).join('; ') : (body.detail ?? r.statusText))
  return body
}

export const listAttachments = (itemId) => req(`/items/${itemId}/attachments`)
export const deleteAttachment = (id) => req(`/attachments/${id}`, { method: 'DELETE' })

export async function fetchAttachmentBlob(id) {
  const token = getToken()
  const r = await fetch(`/attachments/${id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return r.ok ? r.blob() : null
}
