// Pure calendar-layout helpers for TripCalendar.jsx — no React, so these are
// unit-testable in isolation (frontend/src/__tests__/calendarModel.test.js,
// frontend/src/__tests__/calendarModel.planning.test.js).
//
// Placement of items on days reuses itemDateKey/itemSortKey from StopCard.jsx
// (plan-16, decision D3) rather than reimplementing the per-kind date rules —
// a flight belongs on its depart_time day, an accommodation on its checkin
// day, everything else on scheduled_at. Do not duplicate that logic here.
import { itemDateKey, itemSortKey } from './components/StopCard.jsx'

// Accepted shapes for a stored local wall-clock date/datetime string, most
// specific first — mirrors backend/reschedule.py's _STR_FORMATS exactly so
// shiftDateStr below shifts the same shapes the server does.
const _DT_SHAPES = [
  { re: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/, time: true, seconds: true },
  { re: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/, time: true, seconds: false },
  { re: /^(\d{4})-(\d{2})-(\d{2})$/, time: false, seconds: false },
]

// Shift a local wall-clock date/datetime string by whole days, preserving its
// exact input shape — a date-only string stays date-only, seconds are kept
// iff the input had them, time-of-day is untouched. Mirrors
// backend/reschedule.py::shift_datetime_str field-for-field (plan-16d):
// planning-mode previews must shift dates the same way the server will on
// Save, or the preview would lie. Day arithmetic is done in UTC on the
// parsed y/m/d components (never via the device's local Date + setDate) so
// it can't be perturbed by the viewer's own timezone/DST — these strings
// carry no zone of their own (CLAUDE.md's "Timezone handling"). Returns the
// input unchanged if it isn't a non-empty string or doesn't match one of the
// shapes above — this reads free-form imported/typed data, so it must never
// throw. Also used for the calendar's own date-only day-key arithmetic
// (weeksCovering, dayKeysBetween, shiftPeriod below) — those only ever pass
// the date-only shape, so this stays behaviourally identical for them.
function shiftDateStr(value, deltaDays) {
  if (typeof value !== 'string' || !value) return value
  for (const { re, time, seconds } of _DT_SHAPES) {
    const m = value.match(re)
    if (!m) continue
    const [, y, mo, d, h, mi, s] = m
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)))
    dt.setUTCDate(dt.getUTCDate() + deltaDays)
    const ys = dt.getUTCFullYear()
    const ms = String(dt.getUTCMonth() + 1).padStart(2, '0')
    const ds = String(dt.getUTCDate()).padStart(2, '0')
    if (!time) return `${ys}-${ms}-${ds}`
    return `${ys}-${ms}-${ds}T${h}:${mi}${seconds ? `:${s}` : ''}`
  }
  return value
}

// The complete set of `details` keys that carry a datetime (plan-16 D3) —
// used to widen the Trip-view date range (itemDateParts below) AND, in
// planning mode, to shift every date-bearing field of a moved stop's items
// (applyDraft) exactly like backend/reschedule.py::ITEM_DATETIME_KEYS.
// `scheduled_at` is the top-level field and is handled separately, same
// split as the backend module. Keep this list in lockstep with that one and
// with the `datetime-local` fields in ItemEditModal.jsx — see
// frontend/src/__tests__/calendarModel.planning.test.js's grep-agreement
// test, the frontend twin of tests/test_reschedule.py's.
export const ITEM_DATETIME_KEYS = ['checkin', 'checkout', 'bag_drop', 'depart_time', 'arrive_time', 'pickup_time', 'dropoff_time']

function itemDateParts(item) {
  const out = []
  if (item.scheduled_at) out.push(String(item.scheduled_at).slice(0, 10))
  const d = item.details || {}
  for (const k of ITEM_DATETIME_KEYS) {
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

// Deterministic small-int hash (xorshift/multiply, not cryptographic) so a
// stop's colour perturbation is stable across renders and reloads without
// storing a random seed anywhere — Math.random() would reshuffle colours on
// every fetch, which would be worse than no colour-coding at all.
function hashInt(n) {
  let h = (n ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

// A ranked stop's band colour comes from a hue *family* keyed on its
// priority number, not the plain per-trip --stop-N rotation — every
// priority-1 stop reads as "the blue option", every priority-2 stop as a
// different, clearly-distinct family, and so on, so competing options are
// recognisable across the whole calendar at a glance. Families are spread
// with the golden angle starting from blue: priority 1 is blue as a
// deliberate anchor, and every later priority lands far around the wheel
// from its neighbours even for small, consecutive priority numbers.
// Within a family, a stop's own id perturbs hue/saturation/lightness a
// little — "just enough" to tell same-priority stops apart — deterministically
// (hashInt, not Math.random()) so the colour doesn't change on every reload.
const GOLDEN_ANGLE = 137.508
const PRIORITY_1_HUE = 210 // blue

export function priorityBandColor(priority, stopId) {
  const baseHue = (PRIORITY_1_HUE + (Number(priority) - 1) * GOLDEN_ANGLE) % 360
  const h = hashInt(Number(stopId) || 0)
  const hueJitter = (h % 41) - 20             // ±20°, small next to the 137° gap between families
  const lightness = 68 + ((h >>> 8) % 5) * 3  // 68–80%, matching the pastel --stop-N palette's range
  const saturation = 55 + ((h >>> 16) % 4) * 6 // 55–73%
  const hue = (baseHue + hueJitter + 360) % 360
  return `hsl(${hue.toFixed(1)}deg ${saturation}% ${lightness}%)`
}

// One band per dated stop (arrive and/or depart). A stop with only one of
// the two becomes a one-day band on that day; a fully undated stop is
// omitted (the caller lists those separately — see TripCalendar's "Undated
// stops" strip). colorIndex is the stop's position in timeline order, mod 8,
// matching the --stop-1…--stop-8 palette in index.css — used only when the
// stop has no priority; `color` (a priorityBandColor hsl() string, or null)
// takes precedence whenever one is set.
export function stopBands(timeline) {
  const stops = timeline?.stops || []
  const bands = []
  stops.forEach((stop, i) => {
    const arrive = stop.arrive ? String(stop.arrive).slice(0, 10) : null
    const depart = stop.depart ? String(stop.depart).slice(0, 10) : null
    if (!arrive && !depart) return
    const color = stop.priority != null ? priorityBandColor(stop.priority, stop.id) : null
    bands.push({ stop, first: arrive || depart, last: depart || arrive, colorIndex: i % 8, color })
  })
  return bands
}

// Greedy interval-colouring (plan-16 D7), sorted by priority first (lower
// number = earlier = a lower, "more top" lane — the whole point of ranking
// overlapping options) and start day second, then place each band in the
// first lane whose last-placed band ended before this one starts. Overlap
// is inclusive of the end day — a band ending on day X and one starting on
// day X are treated as overlapping and can't share a lane. An unranked stop
// (priority null/undefined) sorts after every ranked one; ties (same
// priority, or both unranked) fall back to start-day order, same as before
// priority existed. Processing out of pure chronological order can only
// ever make the packing use a lane or two more than the true minimum for
// bands that don't actually overlap in dates — the `end < start` check
// itself is date-based and always safe, so two overlapping bands can never
// land in the same lane regardless of processing order.
export function packLanes(bands) {
  const rank = b => (b.stop?.priority ?? Infinity)
  const sorted = [...bands].sort((a, b) => {
    const pa = rank(a), pb = rank(b)
    if (pa !== pb) return pa - pb
    return a.first < b.first ? -1 : a.first > b.first ? 1 : 0
  })
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

// A stop-band segment clipped to one displayed week row — a band spanning
// several weeks is drawn once per week it touches (two segments for a stop
// crossing a single week boundary, etc). null when the band doesn't reach
// this week at all. Moved here (out of TripCalendar.jsx) in plan-16d so
// PlanningOverlay's unified multi-week grid can lay out the same bands with
// the same per-week clipping, without duplicating the logic.
export function bandSegmentForWeek(band, week) {
  const weekStart = week[0], weekEnd = week[6]
  if (band.last < weekStart || band.first > weekEnd) return null
  const segFirst = band.first < weekStart ? weekStart : band.first
  const segLast = band.last > weekEnd ? weekEnd : band.last
  const startCol = week.indexOf(segFirst) + 1
  const endCol = week.indexOf(segLast) + 2 // CSS grid end line is exclusive
  return { startCol, endCol }
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

// ── Planning mode (plan-16d) ────────────────────────────────────────────────
// A "draft" is the pure, client-only accumulation of unsaved planning-mode
// edits: { moves: {[stopId]: {arrive, depart}}, creates: {[tempId]: {location,
// country, timezone, arrive, depart}}, deletes: number[] }. Nothing here ever
// touches the network (plan-16 D10) — Save (App.jsx) turns a draft into one
// `POST /trips/{id}/reschedule` body via draftToRequest.
export function emptyDraft() {
  return { moves: {}, creates: {}, deletes: [] }
}

export function draftChangeCount(draft) {
  if (!draft) return 0
  return Object.keys(draft.moves || {}).length + Object.keys(draft.creates || {}).length + (draft.deletes || []).length
}

// D4's whole-day delta, mirroring backend/reschedule.py::stop_delta_days
// exactly: arrive-based, depart as fallback when there's no arrive, 0 when
// the OLD stop had neither (nothing to be relative to). Comparing calendar
// dates only (not full datetimes), same reasoning as the backend twin: a
// stop whose arrive time-of-day changed without its calendar day changing is
// a resize, not a move.
export function stopDeltaDays(oldArrive, oldDepart, newArrive, newDepart) {
  const oldAnchor = oldArrive || oldDepart
  const newAnchor = newArrive || newDepart
  if (!oldAnchor || !newAnchor) return 0
  return daysBetweenDayKeys(String(oldAnchor).slice(0, 10), String(newAnchor).slice(0, 10))
}

// Whole days from day-key `a` to day-key `b` ('YYYY-MM-DD' strings), i.e.
// `b - a`. Used by stopDeltaDays above and by PlanningOverlay.jsx to turn a
// drag's start/current day into a delta before shifting a band's dates.
export function daysBetweenDayKeys(a, b) {
  if (!a || !b) return 0
  const [ay, am, ad] = a.split('-').map(Number)
  const [by_, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by_, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

// Shift every present, parseable datetime field of `item` by `deltaDays`
// whole days — the top-level `scheduled_at` plus every ITEM_DATETIME_KEYS
// entry in `item.details` — mirroring backend/reschedule.py::shift_item.
// Pure: returns `item` unchanged (same identity) when delta is 0 or nothing
// on the item actually shifts, and otherwise a new item object (new
// `details` identity too) so callers can rely on reference-equality to tell
// whether anything changed.
function shiftItemForPreview(item, deltaDays) {
  if (deltaDays === 0) return item
  let changed = false
  const next = { ...item }
  if (item.scheduled_at) {
    const shifted = shiftDateStr(item.scheduled_at, deltaDays)
    if (shifted !== item.scheduled_at) { next.scheduled_at = shifted; changed = true }
  }
  const details = item.details || {}
  let newDetails = null
  for (const key of ITEM_DATETIME_KEYS) {
    const val = details[key]
    if (!val) continue
    const shifted = shiftDateStr(val, deltaDays)
    if (shifted !== val) {
      if (!newDetails) newDetails = { ...details }
      newDetails[key] = shifted
      changed = true
    }
  }
  if (newDetails) next.details = newDetails
  return changed ? next : item
}

// applyDraft(timeline, draft) -> timeline' — pure preview of what Save will
// do: a new timeline object whose stops reflect the draft (moved dates
// applied, temp-id creates appended, deleted stops removed) and whose items
// are shifted by D4's rule so the on-screen preview matches the server
// exactly. Never mutates `timeline` or any of its stops/items. Deleted stops
// are dropped from the result entirely — TripCalendar renders their
// struck-through band separately, straight from the original timeline plus
// draft.deletes, specifically so a still-visible "about to be deleted" band
// doesn't also (wrongly) contribute a live chip preview here.
export function applyDraft(timeline, draft) {
  if (!timeline) return timeline
  const d = draft || emptyDraft()
  const deletes = new Set(d.deletes || [])
  const moves = d.moves || {}
  const creates = d.creates || {}

  const stops = []
  for (const stop of timeline.stops || []) {
    if (deletes.has(stop.id)) continue
    const move = moves[stop.id]
    if (!move) { stops.push(stop); continue }
    const delta = stopDeltaDays(stop.arrive, stop.depart, move.arrive, move.depart)
    const items = delta === 0 ? (stop.items || []) : (stop.items || []).map(it => shiftItemForPreview(it, delta))
    stops.push({ ...stop, arrive: move.arrive, depart: move.depart, items })
  }
  for (const [tempId, c] of Object.entries(creates)) {
    stops.push({
      id: tempId, location: c.location, country: c.country || '',
      arrive: c.arrive, depart: c.depart, timezone: c.timezone ?? '0',
      items: [], isDraftNew: true,
    })
  }
  return { ...timeline, stops }
}

// draftToRequest(draft, originalStops) -> RescheduleRequest body (see
// backend/models.py's RescheduleRequest / docs/plans/plan-16a-reschedule-api.md).
// `originalStops` is the real, unmodified timeline.stops (for each moved
// stop's `base`, compare-and-set per D6/backend/compare_and_set.py). Only
// stops whose dates actually changed from their original values go into
// `moves` — a stop touched by the "Place" flow and then untouched again, or
// a move dragged back to its own start, must not generate a no-op PATCH.
export function draftToRequest(draft, originalStops) {
  const d = draft || emptyDraft()
  const byId = new Map((originalStops || []).map(s => [s.id, s]))
  const moves = []
  for (const [stopIdStr, move] of Object.entries(d.moves || {})) {
    const stopId = Number(stopIdStr)
    const orig = byId.get(stopId)
    if (!orig) continue
    if ((orig.arrive || null) === (move.arrive || null) && (orig.depart || null) === (move.depart || null)) continue
    moves.push({ stop_id: stopId, arrive: move.arrive || null, depart: move.depart || null, base: { arrive: orig.arrive || null, depart: orig.depart || null } })
  }
  const creates = Object.entries(d.creates || {}).map(([tempId, c]) => ({
    location: c.location, country: c.country || '',
    arrive: c.arrive || null, depart: c.depart || null,
    timezone: c.timezone || '0', client_ref: tempId,
  }))
  const deletes = [...(d.deletes || [])]
  return { moves, creates, deletes }
}

// D8 grid geometry — deterministic hit testing from a pointer position, no
// elementFromPoint. `gridRect` is any {left, top, width} (a DOMRect works).
// col/row are clamped into [0, cols-1] / [0, ∞) — a point exactly on a
// column's right edge belongs to the column to its right (plain floor
// division), matching how the CSS grid itself lines up.
export function cellFromPoint(gridRect, cols, rowHeight, x, y) {
  const cellWidth = gridRect.width / cols
  let col = Math.floor((x - gridRect.left) / cellWidth)
  col = Math.max(0, Math.min(cols - 1, col))
  let row = Math.floor((y - gridRect.top) / rowHeight)
  row = Math.max(0, row)
  return { col, row }
}

// The day key a {col, row} cell (from cellFromPoint) refers to, given the
// same `weeks` array (weeksCovering's output) the grid was rendered from.
// Out-of-grid rows/cols clamp to the nearest real cell rather than returning
// null, so a drag that overshoots past the last week still resolves to a day.
export function dayKeyAt(weeks, { col, row }) {
  if (!weeks || !weeks.length) return null
  const r = Math.max(0, Math.min(weeks.length - 1, row))
  const c = Math.max(0, Math.min(6, col))
  return weeks[r][c]
}
