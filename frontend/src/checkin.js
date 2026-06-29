/**
 * Online check-in helpers for flight items.
 *
 * Stored fields:
 *   details.checkin_window  — how far before departure check-in opens ("48h", "2d", "24")
 *   details.checkin_url     — airline check-in page URL
 */

/**
 * Parse a check-in window string to a number of hours.
 * Returns null when input is missing or not parseable.
 *
 * Accepts: "48", "48h", "48hr", "48 hours", "2d", "2 days"
 */
export function parseCheckinWindow(s) {
  if (!s) return null
  s = String(s).trim().toLowerCase()

  // Days: "2d", "2 days", "2day"
  let m = s.match(/^(\d+(?:\.\d+)?)\s*d(?:ay)?s?$/)
  if (m) return +m[1] * 24

  // Hours: "48", "48h", "48hr", "48 hours"
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:h(?:r|ours?)?)?$/)
  if (m && m[1]) return +m[1]

  return null
}

/**
 * Subtract windowHours from departTime (ISO "YYYY-MM-DDTHH:MM") and return
 * the result in the same format, or null on any invalid input.
 */
export function calcCheckinTime(departTime, windowHours) {
  if (!departTime || windowHours == null) return null
  try {
    // Parse as wall-clock local time (no TZ conversion)
    const d = new Date(String(departTime).slice(0, 16).replace('T', 'T'))
    if (isNaN(d.getTime())) return null
    const ms = d.getTime() - windowHours * 3_600_000
    const r = new Date(ms)
    const pad = n => String(n).padStart(2, '0')
    return `${r.getFullYear()}-${pad(r.getMonth() + 1)}-${pad(r.getDate())}T${pad(r.getHours())}:${pad(r.getMinutes())}`
  } catch {
    return null
  }
}
