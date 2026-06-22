import { formatAmount, parseCost } from '../currency.js'

/**
 * Renders cost information from stored values only — no API calls.
 *
 * Without amount_paid: inline  "€450 (£375)"
 * With amount_paid:    block breakdown showing total, paid, outstanding
 *
 * Converted amounts come from item.details.converted_* (written at save time).
 */
export default function CostDisplay({ item, className = '' }) {
  const cost = item?.cost
  const d = item?.details ?? {}
  const amountPaid    = d.amount_paid
  const convertedCost = d.converted_cost
  const convertedPaid = d.converted_amount_paid
  const convertedCurrency = d.converted_currency

  if (!cost) return null

  const parsedCost = parseCost(cost)
  const showConverted = convertedCost != null && convertedCurrency && convertedCurrency !== parsedCost?.code

  // ── Simple inline mode (no paid amount) ────────────────────────────────────
  if (!amountPaid) {
    return (
      <span className={className}>
        {cost}
        {showConverted && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.85em' }}>
            {' '}({formatAmount(convertedCost, convertedCurrency)})
          </span>
        )}
      </span>
    )
  }

  // ── Breakdown mode (paid amount present) ───────────────────────────────────
  const parsedPaid = parseCost(amountPaid) ?? { amount: parseFloat(amountPaid), code: parsedCost?.code }
  const outstanding    = parsedCost && parsedPaid.amount != null ? parsedCost.amount - parsedPaid.amount : null
  const convertedOutstanding = convertedCost != null && convertedPaid != null
    ? Math.round((convertedCost - convertedPaid) * 100) / 100
    : null

  const fullyPaid = outstanding != null && outstanding <= 0

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>

      {/* Total */}
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>Total</span>
        <span>{cost}</span>
        {showConverted && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>
            ({formatAmount(convertedCost, convertedCurrency)})
          </span>
        )}
      </div>

      {/* Paid */}
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>Paid</span>
        <span>{amountPaid}</span>
        {convertedPaid != null && convertedCurrency && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>
            ({formatAmount(convertedPaid, convertedCurrency)})
          </span>
        )}
      </div>

      {/* Outstanding / Fully paid */}
      {fullyPaid ? (
        <div>
          <span style={{ color: 'var(--success)', fontSize: '0.8em' }}>Fully paid ✓</span>
        </div>
      ) : outstanding != null && outstanding > 0 ? (
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>Outstanding</span>
          <span style={{ color: 'var(--warning)', fontWeight: 500 }}>
            {parsedCost?.code ? formatAmount(outstanding, parsedCost.code) : outstanding.toFixed(2)}
          </span>
          {convertedOutstanding != null && convertedOutstanding > 0 && convertedCurrency && (
            <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>
              ({formatAmount(convertedOutstanding, convertedCurrency)})
            </span>
          )}
        </div>
      ) : null}

    </div>
  )
}
