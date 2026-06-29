/**
 * Baggage parsing and aggregation for the flight detail view.
 *
 * Handles the variety of formats airlines use:
 *   "23kg"  "23 kg"  "2 x 23kg"  "2 × 32kg"  "2 bags"  "1 piece 23kg"
 *   "2x checked bag max 32kg"  "40kg international Business (Non FF/Bronze)"
 *   "carry-on"  "cabin bag"  "hand luggage"
 */

const CARRY_ON_RE  = /carry.?on|cabin bag|hand luggage|personal item/i
const MULTI_RE     = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*k(?:g\b)?/i   // "2 x 23kg" or "2 x 23K"
const QUANTITY_RE  = /^(\d+)\s*[x×]/i                                   // "2x anything"
const PIECES_RE    = /^(\d+)\s*(?:bag|piece|item|pc)s?/i                 // "2 bags" / "2PC"
const WEIGHT_RE    = /(\d+(?:\.\d+)?)\s*k(?:g\b)?/i                     // "23kg" or "23K"

/**
 * Parse a single baggage string.
 * Returns { holdBags: number, holdKg: number|null, carryOn: boolean }
 */
export function parseBaggage(s) {
  if (!s) return { holdBags: 0, holdKg: null, carryOn: false }
  s = String(s).trim()
  const carryOn = CARRY_ON_RE.test(s)

  // "2 x 23kg" / "2 × 32kg" (quantity directly before weight)
  let m = MULTI_RE.exec(s)
  if (m) return { holdBags: +m[1], holdKg: +m[2], carryOn }

  // "2x anything … 32kg" — quantity prefix with words in between
  m = QUANTITY_RE.exec(s)
  if (m) {
    const w = WEIGHT_RE.exec(s)
    return { holdBags: +m[1], holdKg: w ? +w[1] : null, carryOn }
  }

  // "N bags/pieces [weight]"
  m = PIECES_RE.exec(s)
  if (m) {
    const w = WEIGHT_RE.exec(s)
    return { holdBags: +m[1], holdKg: w ? +w[1] : null, carryOn }
  }

  // Plain weight: "23kg" / "40kg international…"
  m = WEIGHT_RE.exec(s)
  if (m) return { holdBags: 1, holdKg: +m[1], carryOn }

  if (carryOn) return { holdBags: 0, holdKg: null, carryOn: true }
  return { holdBags: 0, holdKg: null, carryOn: false }
}

/**
 * Aggregate per-passenger baggage into a single summary string.
 *
 * Carry-on is always listed separately and never added to hold totals.
 * Different passengers may have different allowances — each is parsed
 * individually and summed.
 *
 * Returns a string like:
 *   "4 bags (128kg checked)"
 *   "2 bags checked · carry-on"
 *   "carry-on"
 * or null if no baggage info is present.
 */
export function aggregateBaggage(passengers) {
  if (!Array.isArray(passengers)) return null

  let totalBags = 0
  let totalKg   = 0
  let hasKg     = false
  let hasCarry  = false

  for (const p of passengers) {
    const bag = p?.baggage
    if (!bag) continue
    const { holdBags, holdKg, carryOn } = parseBaggage(bag)
    if (carryOn) hasCarry = true
    if (holdBags > 0) {
      totalBags += holdBags
      if (holdKg != null) { totalKg += holdBags * holdKg; hasKg = true }
    }
  }

  if (totalBags === 0 && !hasCarry) return null

  const parts = []
  if (totalBags > 0) {
    let hold = `${totalBags} bag${totalBags !== 1 ? 's' : ''}`
    if (hasKg) hold += ` (${totalKg}kg checked)`
    else hold += ' checked'
    parts.push(hold)
  }
  if (hasCarry) parts.push('carry-on')

  return parts.join(' · ') || null
}
