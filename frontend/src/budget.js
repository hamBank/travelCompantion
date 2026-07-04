import { parseCost, getHomeCurrency } from './currency.js'

/**
 * Aggregates planned/paid spend across a flat list of itinerary items into the
 * home currency. Mirrors CostDisplay's rules for interpreting cost/details fields:
 * prefer the pre-converted details.converted_cost/converted_amount_paid when the
 * currency differs from home, otherwise parse the raw string directly when it's
 * already in the home currency. Items whose cost is in a foreign currency with no
 * conversion on record are bucketed into `unconvertible` rather than silently
 * mis-summed.
 *
 * @param {Array} items - flat array of ItineraryItems (all stops)
 * @param {string} homeCurrency - e.g. "AUD"
 * @returns {{planned: number, paid: number, byKind: Object, unconvertible: string[]}}
 */
export function aggregateSpend(items, homeCurrency) {
  const home = homeCurrency || getHomeCurrency()
  let planned = 0
  let paid = 0
  const byKind = {}
  const unconvertible = []

  for (const item of items ?? []) {
    const cost = item?.cost
    if (!cost) continue

    const d = item?.details ?? {}
    const parsedCost = parseCost(cost)
    const costCode = parsedCost?.code ?? ''

    let plannedAmt = null
    if (d.converted_cost != null && d.converted_currency === home) {
      plannedAmt = d.converted_cost
    } else if (costCode === home && parsedCost) {
      plannedAmt = parsedCost.amount
    } else if (!costCode && parsedCost) {
      // No currency code detected — treat as already-home-currency plain number.
      plannedAmt = parsedCost.amount
    }

    if (plannedAmt == null) {
      unconvertible.push(item.name)
      continue
    }

    let paidAmt = 0
    const amountPaid = d.amount_paid
    if (amountPaid) {
      if (d.converted_amount_paid != null && d.converted_currency === home) {
        paidAmt = d.converted_amount_paid
      } else {
        const parsedPaid = parseCost(amountPaid)
        const paidCode = parsedPaid?.code ?? ''
        if (paidCode === home || !paidCode) {
          paidAmt = parsedPaid?.amount ?? 0
        }
      }
    }

    planned += plannedAmt
    paid += paidAmt

    const kind = item.kind ?? 'other'
    if (!byKind[kind]) byKind[kind] = { planned: 0, paid: 0 }
    byKind[kind].planned += plannedAmt
    byKind[kind].paid += paidAmt
  }

  return { planned, paid, byKind, unconvertible }
}
