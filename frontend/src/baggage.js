/**
 * Baggage parsing and aggregation for the flight detail view.
 *
 * Handles the variety of formats airlines use:
 *   "23kg"  "23 kg"  "2 x 23kg"  "2 × 32kg"  "2 bags"  "1 piece 23kg"
 *   "2x checked bag max 32kg"  "40kg international Business (Non FF/Bronze)"
 *   "2PC 32K"  "40K"  "carry-on"  "cabin bag"
 *
 * Key distinction: "40K" is a weight allowance (unknown bag count);
 * "2PC 32K" is an explicit count (2 pieces). Only explicit counts show in
 * the aggregated summary as "N bags"; weight-only allowances show as "Xkg".
 */

const CARRY_ON_RE  = /carry.?on|cabin bag|hand luggage|personal item/i
const MULTI_RE     = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*k(?:g\b)?/i   // "2 x 23kg"
const QUANTITY_RE  = /^(\d+)\s*[x×]/i                                   // "2x anything"
const PIECES_RE    = /^(\d+)\s*(?:bag|piece|item|pc)s?/i                 // "2 bags" / "2PC"
const WEIGHT_RE    = /(\d+(?:\.\d+)?)\s*k(?:g\b)?/i                     // "23kg" or "23K"

/**
 * Parse a single baggage string.
 * Returns { holdBags, holdKg, bagCountKnown, carryOn }
 *
 * bagCountKnown=true  → explicit piece count (2PC, 2 bags, 2×23kg)
 * bagCountKnown=false → weight-only allowance (40K, 23kg) — no bag limit implied
 */
export function parseBaggage(s) {
  if (!s) return { holdBags: 0, holdKg: null, bagCountKnown: false, carryOn: false }
  s = String(s).trim()
  const carryOn = CARRY_ON_RE.test(s)

  // "2 x 23kg" / "2 × 32kg" — explicit count + weight
  let m = MULTI_RE.exec(s)
  if (m) return { holdBags: +m[1], holdKg: +m[2], bagCountKnown: true, carryOn }

  // "2x anything … 32kg" — quantity prefix with words in between
  m = QUANTITY_RE.exec(s)
  if (m) {
    const w = WEIGHT_RE.exec(s)
    return { holdBags: +m[1], holdKg: w ? +w[1] : null, bagCountKnown: true, carryOn }
  }

  // "N bags/pieces [weight]"
  m = PIECES_RE.exec(s)
  if (m) {
    const w = WEIGHT_RE.exec(s)
    return { holdBags: +m[1], holdKg: w ? +w[1] : null, bagCountKnown: true, carryOn }
  }

  // Plain weight only: "23kg" / "40K" / "40kg international…"
  // No bag count — could be any number of bags up to this weight total.
  m = WEIGHT_RE.exec(s)
  if (m) return { holdBags: 0, holdKg: +m[1], bagCountKnown: false, carryOn }

  if (carryOn) return { holdBags: 0, holdKg: null, bagCountKnown: false, carryOn: true }
  return { holdBags: 0, holdKg: null, bagCountKnown: false, carryOn: false }
}

/**
 * Aggregate per-passenger baggage into a single summary string.
 *
 * Explicit counts (2PC, 2 bags): summed as "N bags (Xkg checked)"
 * Weight-only (40K, 23kg):       summed as "Xkg checked"
 * Mixed:                         "N bags (Xkg) + Ykg checked"
 * Carry-on:                      always separate "· carry-on"
 */
export function aggregateBaggage(passengers) {
  if (!Array.isArray(passengers)) return null

  let countedBags = 0
  let countedKg   = 0
  let hasCountedKg = false
  let weightOnlyKg = 0
  let hasWeightOnly = false
  let hasCarry  = false

  for (const p of passengers) {
    const bag = p?.baggage
    if (!bag) continue
    const { holdBags, holdKg, bagCountKnown, carryOn } = parseBaggage(bag)
    if (carryOn) hasCarry = true

    if (bagCountKnown && holdBags > 0) {
      countedBags += holdBags
      if (holdKg != null) { countedKg += holdBags * holdKg; hasCountedKg = true }
    } else if (!bagCountKnown && holdKg != null) {
      weightOnlyKg += holdKg
      hasWeightOnly = true
    }
  }

  if (countedBags === 0 && !hasWeightOnly && !hasCarry) return null

  const parts = []
  if (countedBags > 0 || hasWeightOnly) {
    const holdParts = []
    if (countedBags > 0) {
      let counted = `${countedBags} bag${countedBags !== 1 ? 's' : ''}`
      if (hasCountedKg) counted += ` (${countedKg}kg)`
      holdParts.push(counted)
    }
    if (hasWeightOnly) holdParts.push(`${weightOnlyKg}kg`)
    parts.push(holdParts.join(' + ') + ' checked')
  }
  if (hasCarry) parts.push('carry-on')

  return parts.join(' · ') || null
}
