// Lightweight longitude-based local-day approximation — mirrors
// backend/tzutil.py. Real timezone boundaries don't follow longitude
// exactly, but for deciding which calendar day it currently is somewhere
// (accurate to within an hour or two), that's more than enough, and it
// avoids pulling in a real tz-database library just to pick a default day.

export function approxUtcOffsetHours(lng) {
  return Math.max(-12, Math.min(14, Math.round(lng / 15)))
}

// YYYY-MM-DD at `lng`'s approximate local time, for the instant `now`
// represents. `now.getTime()` is timezone-agnostic (epoch ms), so shifting
// by the approximate offset and reading UTC fields back off avoids double-
// applying the browser's own local offset on top of it.
export function approxLocalDateStr(lng, now = new Date()) {
  if (lng == null || Number.isNaN(Number(lng))) return now.toLocaleDateString('sv-SE')
  const shifted = new Date(now.getTime() + approxUtcOffsetHours(Number(lng)) * 3600 * 1000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
