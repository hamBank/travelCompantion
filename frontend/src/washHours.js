/**
 * Opening-hours filtering for laundry facilities.
 *
 * Google Places weekday_text is stored as an array of strings:
 *   ["Monday: 7:00 AM – 9:00 PM", "Tuesday: ...", ...]
 *
 * We filter to only the days covered by the accommodation stay.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Returns a Set of JS day-of-week indices (0=Sun … 6=Sat) covered by the
 * accommodation stay, or null when no check-in date is available.
 */
export function relevantDayIndices(checkin, checkout) {
  if (!checkin) return null
  const start = new Date(String(checkin).slice(0, 10) + 'T00:00')
  const end   = checkout
    ? new Date(String(checkout).slice(0, 10) + 'T00:00')
    : new Date(start.getTime() + 86_400_000)

  const days = new Set()
  const cur  = new Date(start)
  while (cur <= end) {
    days.add(cur.getDay())
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

/**
 * Filter a weekday_text array to only the entries whose day name appears in
 * `relevantDays`. Falls through gracefully for:
 *   - null/undefined hours → returned unchanged
 *   - legacy string hours  → returned as-is (no filtering possible)
 *   - null relevantDays    → full array returned (no dates set)
 */
export function filterHoursByDays(hours, relevantDays) {
  if (hours == null) return hours
  if (!Array.isArray(hours)) return hours          // legacy string — show as-is
  if (!relevantDays) return hours                  // no date context — show all

  return hours.filter(line => {
    const dayName = String(line).split(':')[0].trim()
    const idx = DAY_NAMES.indexOf(dayName)
    return idx !== -1 && relevantDays.has(idx)
  })
}
