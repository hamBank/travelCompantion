// Pure calendar-layout helpers for TripCalendar.jsx — no React, so these are
// unit-testable in isolation (frontend/src/__tests__/calendarModel.test.js).
//
// Placement of items on days reuses itemDateKey/itemSortKey from StopCard.jsx
// (plan-16, decision D3) rather than reimplementing the per-kind date rules —
// a flight belongs on its depart_time day, an accommodation on its checkin
// day, everything else on scheduled_at. Do not duplicate that logic here.
import { itemDateKey, itemSortKey } from './components/StopCard.jsx'

// Shift a 'YYYY-MM-DD' string by N days using the device's local calendar —
// same approach as shiftDay in TripTimeline.jsx, duplicated deliberately: this
// module is plain data logic imported by both TripCalendar.jsx and its tests,
// and must not pull in a React component file just for a date helper.
function shiftDateStr(dateStr, deltaDays) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + deltaDays)
  return d.toLocaleDateString('sv-SE')
}

// The complete set of datetime-bearing fields an item can carry (plan-16 D3),
// used only to widen the Trip-view date range — NOT for placement (that's
// itemDateKey's job, used by itemsByDay below).
const DATE_DETAIL_KEYS = ['checkin', 'checkout', 'bag_drop', 'depart_time', 'arrive_time', 'pickup_time', 'dropoff_time']

function itemDateParts(item) {
  const out = []
  if (item.scheduled_at) out.push(String(item.scheduled_at).slice(0, 10))
  const d = item.details || {}
  for (const k of DATE_DETAIL_KEYS) {
    if (d[k]) out.push(String(d[k]).slice(0, 10))
  }
  return out
}

// First/last day covered by the trip (plan-16 D2): min/max across
// trip.start_date/end_date, every stop's arrive/depart, and every item's
// dated fields. Each term only ever widens the range (a null/missing term is
// simply skipped, never used to clamp). null when nothing at all is dated.
export function tripDateRange(timeline) {
  if (!timeline) return null
  let first = null
  let last = null
  const consider = dateStr => {
    if (!dateStr) return
    if (first === null || dateStr < first) first = dateStr
    if (last === null || dateStr > last) last = dateStr
  }
  consider(timeline.start_date ? String(timeline.start_date).slice(0, 10) : null)
  consider(timeline.end_date ? String(timeline.end_date).slice(0, 10) : null)
  for (const stop of timeline.stops || []) {
    consider(stop.arrive ? String(stop.arrive).slice(0, 10) : null)
    consider(stop.depart ? String(stop.depart).slice(0, 10) : null)
    for (const item of stop.items || []) {
      for (const dateStr of itemDateParts(item)) consider(dateStr)
    }
  }
  return first !== null ? { first, last } : null
}

// Every day key from `first` to `last`, inclusive.
export function dayKeysBetween(first, last) {
  const out = []
  let d = first
  let guard = 0
  while (d <= last && guard++ < 5000) {
    out.push(d)
    d = shiftDateStr(d, 1)
  }
  return out
}

// Rows of 7 day keys covering [first, last], padded so the first row starts
// on the week's first day (Monday by default — weekStartsOn: 0=Sun..6=Sat)
// and the last row ends on its last day.
export function weeksCovering(first, last, weekStartsOn = 1) {
  if (!first || !last) return []
  const weekdayOf = dateStr => new Date(dateStr + 'T00:00:00').getDay() // 0=Sun..6=Sat
  const sinceWeekStart = wd => (wd - weekStartsOn + 7) % 7
  const startPad = sinceWeekStart(weekdayOf(first))
  const endPad = 6 - sinceWeekStart(weekdayOf(last))
  const paddedStart = shiftDateStr(first, -startPad)
  const paddedEnd = shiftDateStr(last, endPad)
  const days = dayKeysBetween(paddedStart, paddedEnd)
  const weeks = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
  return weeks
}

// One band per dated stop (arrive and/or depart). A stop with only one of
// the two becomes a one-day band on that day; a fully undated stop is
// omitted (the caller lists those separately — see TripCalendar's "Undated
// stops" strip). colorIndex is the stop's position in timeline order, mod 8,
// matching the --stop-1…--stop-8 palette in index.css.
export function stopBands(timeline) {
  const stops = timeline?.stops || []
  const bands = []
  stops.forEach((stop, i) => {
    const arrive = stop.arrive ? String(stop.arrive).slice(0, 10) : null
    const depart = stop.depart ? String(stop.depart).slice(0, 10) : null
    if (!arrive && !depart) return
    bands.push({ stop, first: arrive || depart, last: depart || arrive, colorIndex: i % 8 })
  })
  return bands
}

// Greedy interval-colouring (plan-16 D7): sort by start day, place each band
// in the first lane whose last-placed band ended before this one starts.
// Overlap is inclusive of the end day — a band ending on day X and one
// starting on day X are treated as overlapping and can't share a lane.
export function packLanes(bands) {
  const sorted = [...bands].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
  const laneEnds = []
  return sorted.map(band => {
    let lane = laneEnds.findIndex(end => end < band.first)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(band.last)
    } else {
      laneEnds[lane] = band.last
    }
    return { ...band, lane }
  })
}

// Map<dayKey, item[]> — every item with a placeable date (itemDateKey),
// sorted within each day by itemSortKey. Multi-day items (an accommodation's
// checkin→checkout span, an overnight flight) are placed on their start day
// only in this sub-plan; span rendering is a later item (plan-16 "Later").
export function itemsByDay(timeline) {
  const map = new Map()
  for (const stop of timeline?.stops || []) {
    for (const item of stop.items || []) {
      const day = itemDateKey(item)
      if (!day) continue
      if (!map.has(day)) map.set(day, [])
      map.get(day).push(item)
    }
  }
  for (const items of map.values()) items.sort((a, b) => itemSortKey(a) - itemSortKey(b))
  return map
}

// Move the calendar's anchor day by one period. Week: ±7 days. Month: the
// 1st of the next/previous month (regardless of which day of the month the
// current anchor is). Trip: a no-op — there's only one trip-length page.
export function shiftPeriod(view, anchorDay, delta) {
  if (view === 'week') return shiftDateStr(anchorDay, 7 * delta)
  if (view === 'month') {
    const [y, m] = anchorDay.split('-').map(Number)
    const d = new Date(Date.UTC(y, m - 1 + delta, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
  }
  return anchorDay
}

export { shiftDateStr }
