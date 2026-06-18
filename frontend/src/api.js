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
  if (!r.ok) throw new Error(body.detail ?? r.statusText)
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

export const updateItemStatus = (id, status) => updateItem(id, { status })
export const updateStopStatus = (id, status) => updateStop(id, { status })

export const enrichItem = (id) => req(`/items/${id}/enrich`)
