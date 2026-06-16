async function req(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (r.status === 204) return null
  const body = await r.json()
  if (!r.ok) throw new Error(body.detail ?? r.statusText)
  return body
}

export const getTrips = () => req('/trips/')
export const deleteTrip = (id) => req(`/trips/${id}`, { method: 'DELETE' })
export const getTripTimeline = (id) => req(`/trips/${id}/timeline`)
export const importFromSheets = (trip_name) =>
  req('/import/sheets', { method: 'POST', body: JSON.stringify({ trip_name }) })
export const updateItemStatus = (id, status) =>
  req(`/items/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
export const updateStopStatus = (id, status) =>
  req(`/stops/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
