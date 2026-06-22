// Shared date formatting — keep every date in the app consistent.
//   fmtDay      → "Fri 24 Jul"
//   fmtDayTime  → "Fri 24 Jul 17:15"  (time appended only when present & not 00:00)

/** "Fri 24 Jul" from an ISO date or datetime string. */
export function fmtDay(val) {
  if (!val) return null
  const datePart = String(val).split('T')[0]
  const d = new Date(datePart + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** "Fri 24 Jul 17:15", or "Fri 24 Jul" when no meaningful time is present. */
export function fmtDayTime(val) {
  if (!val) return null
  const [datePart, timePart] = String(val).split('T')
  const day = fmtDay(datePart)
  if (!day) return null
  const t = timePart?.slice(0, 5)
  return t && t !== '00:00' ? `${day} ${t}` : day
}
