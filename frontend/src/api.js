function getToken() { return localStorage.getItem('tc-token') }

// Fired when a request that carried a token comes back 401 — the stored JWT
// has expired (JWT_EXPIRE_DAYS) or been invalidated. AuthenticatedApp
// (App.jsx) listens and signs the user out so they land on the login page,
// instead of the app sitting in a broken every-request-fails state until a
// manual sign-out. The offline write queue survives this (IndexedDB, not
// touched by logout), so queued edits still sync after signing back in.
export const AUTH_EXPIRED_EVENT = 'tc-auth-expired'

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
  // Only when a token was actually sent: a 401 on a token-less request (e.g.
  // a failed login attempt on the login page) is not an expired session.
  if (r.status === 401 && token && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
  }
  if (r.status === 204) return null
  const text = await r.text()
  if (!text) return null
  let body
  try { body = JSON.parse(text) }
  catch { throw new Error(`Server error ${r.status}`) }
  if (!r.ok) {
    const detail = body.detail
    const message = Array.isArray(detail)
      ? detail.map(e => e.msg).join('; ')
      : (detail == null || typeof detail === 'string' ? (detail ?? r.statusText) : JSON.stringify(detail))
    const err = new Error(message)
    err.status = r.status
    err.detail = detail
    throw err
  }
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

// ── Expenses (actual logged spend, issue #59) ───────────────────────────────
export const listExpenses  = (tripId)   => req(`/trips/${tripId}/expenses`)
export const createExpense = (tripId, data) => req(`/trips/${tripId}/expenses`, { method: 'POST', body: JSON.stringify(data) })
export const updateExpense = (id, data) => req(`/expenses/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const deleteExpense = (id)       => req(`/expenses/${id}`, { method: 'DELETE' })

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
export const regenerateImportAddress = () => req('/me/import-address/regenerate', { method: 'POST' })
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

// ── Public share link ────────────────────────────────────────────────────────
export const getShareToken    = (id) => req(`/trips/${id}/share-token`)
export const createShareToken = (id) => req(`/trips/${id}/share-token`, { method: 'POST' })
export const revokeShareToken = (id) => req(`/trips/${id}/share-token`, { method: 'DELETE' })

// Public, unauthenticated fetch of a shared trip's read-only timeline — no
// token/Authorization header attached (deliberately bypasses req()'s
// tc-token attachment; a share link works with no login at all).
export async function getSharedTimeline(token) {
  const r = await fetch(`/shared/${token}/timeline`, { cache: 'no-store' })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let detail
    try { detail = JSON.parse(text).detail } catch { /* ignore */ }
    throw new Error(detail ?? (r.status === 404 ? 'This link is no longer valid.' : r.statusText))
  }
  return r.json()
}

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
  const params = new URLSearchParams()
  for (const loc of locations) params.append('locations', loc)
  const r = await fetch(`/stops/${stopId}/day-map?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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

// ── Document vault (encrypted passport/licence/visa scans, plan-12) ─────────

export const listDocuments  = ()             => req('/me/documents')
export const createDocument = (data)         => req('/me/documents', { method: 'POST', body: JSON.stringify(data) })
export const updateDocument = (id, data)     => req(`/me/documents/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
export const deleteDocument = (id)           => req(`/me/documents/${id}`, { method: 'DELETE' })
export const getDocumentNumber = (id)        => req(`/me/documents/${id}/number`)
export const listDocumentFiles = (docId)     => req(`/me/documents/${docId}/files`)
export const deleteDocumentFile = (docId, fileId) => req(`/me/documents/${docId}/files/${fileId}`, { method: 'DELETE' })
export const getDocumentHolder = (id)        => req(`/me/documents/${id}/holder`)
export const scanPassportFile = (docId, fileId) => req(`/me/documents/${docId}/files/${fileId}/scan`, { method: 'POST' })

export async function uploadDocumentFile(docId, file) {
  const token = getToken()
  const form = new FormData()
  form.append('file', file)
  const r = await fetch(`/me/documents/${docId}/files`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })
  const body = await r.json()
  if (!r.ok) throw new Error(Array.isArray(body.detail) ? body.detail.map(e => e.msg).join('; ') : (body.detail ?? r.statusText))
  return body
}

export async function fetchDocumentFileBlob(docId, fileId) {
  const token = getToken()
  const r = await fetch(`/me/documents/${docId}/files/${fileId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return r.ok ? r.blob() : null
}
