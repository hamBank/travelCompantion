import { parseCost, getHomeCurrency } from './currency.js'

/**
 * Aggregates planned/paid spend across a flat list of itinerary items into the
 * home currency, plus a per-original-currency breakdown (so travellers know how
 * much of each foreign currency to expect to need, not just the converted total).
 * Mirrors CostDisplay's rules for interpreting cost/details fields: prefer the
 * pre-converted details.converted_cost/converted_amount_paid when the currency
 * differs from home, otherwise parse the raw string directly when it's already
 * in the home currency. Items whose cost is in a *recognised* foreign currency
 * with no conversion on record are bucketed into `unconvertible` rather than
 * silently mis-summed into the home-currency total — but they're still counted
 * in `byCurrency` under their own currency code. Items whose cost string has no
 * recognisable currency/amount at all (free-text notes like "Walk" ended up in
 * the cost field, a stray description, etc.) go in `noRecognizableCost`
 * instead — they were never a real cost, so byCurrency has nothing to show for
 * them and pointing the user there would be misleading.
 *
 * @param {Array} items - flat array of ItineraryItems (all stops)
 * @param {string} homeCurrency - e.g. "AUD"
 * @returns {{planned: number, paid: number, byKind: Object, byCurrency: Object, unconvertible: string[], noRecognizableCost: string[]}}
 *   byCurrency[code] is { planned, paid, items: [{ name, planned, paid }] } —
 *   the per-item list is what actually answers "which items did the app
 *   detect as this currency", not just a bare total.
 */
export function aggregateSpend(items, homeCurrency) {
  const home = homeCurrency || getHomeCurrency()
  let planned = 0
  let paid = 0
  const byKind = {}
  const byCurrency = {}
  const unconvertible = []
  const noRecognizableCost = []

  const bump = (code, field, amt, name) => {
    if (!byCurrency[code]) byCurrency[code] = { planned: 0, paid: 0, items: [] }
    byCurrency[code][field] += amt
    let entry = byCurrency[code].items.find(it => it.name === name)
    if (!entry) { entry = { name, planned: 0, paid: 0 }; byCurrency[code].items.push(entry) }
    entry[field] += amt
  }

  for (const item of items ?? []) {
    const cost = item?.cost
    if (!cost) continue

    const d = item?.details ?? {}
    const parsedCost = parseCost(cost, home)
    if (!parsedCost) {
      // A bare "0" (no currency symbol/code) is unambiguous — zero in any
      // currency is zero. Common for a connecting flight leg whose fare is
      // tracked entirely on an earlier leg of the same booking.
      const bareZero = parseFloat(String(cost).replace(/[^\d.]/g, '')) === 0
      if (!bareZero) noRecognizableCost.push(item.name)
      continue
    }

    const costCode = parsedCost.code
    bump(costCode, 'planned', parsedCost.amount, item.name)

    let plannedAmt = null
    if (d.converted_cost != null && d.converted_currency === home) {
      plannedAmt = d.converted_cost
    } else if (costCode === home) {
      plannedAmt = parsedCost.amount
    }

    let paidAmt = 0
    const amountPaid = d.amount_paid
    if (amountPaid) {
      const parsedPaid = parseCost(amountPaid, home)
      const paidCode = parsedPaid?.code || costCode
      const paidRaw = parsedPaid?.amount ?? (parseFloat(amountPaid) || 0)
      bump(paidCode, 'paid', paidRaw, item.name)

      if (d.converted_amount_paid != null && d.converted_currency === home) {
        paidAmt = d.converted_amount_paid
      } else if (paidCode === home) {
        paidAmt = paidRaw
      }
    }

    if (plannedAmt == null) {
      unconvertible.push(item.name)
      continue
    }

    planned += plannedAmt
    paid += paidAmt

    const kind = item.kind ?? 'other'
    if (!byKind[kind]) byKind[kind] = { planned: 0, paid: 0 }
    byKind[kind].planned += plannedAmt
    byKind[kind].paid += paidAmt
  }

  return { planned, paid, byKind, byCurrency, unconvertible, noRecognizableCost }
}
