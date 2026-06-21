import { formatAmount, parseCost } from '../currency.js'

/**
 * Shows cost with optional converted equivalent, and if amount_paid is set,
 * breaks down into total · paid · remaining.
 *
 * Compact mode (default): single line e.g. "€450 (£375)"
 * When amount_paid is present, shows full breakdown.
 */
export default function CostDisplay({ item, className = '' }) {
  const cost = item?.cost
  const d = item?.details ?? {}
  const amountPaid = d.amount_paid
  const convertedCost = d.converted_cost
  const convertedPaid = d.converted_amount_paid
  const convertedCurrency = d.converted_currency

  if (!cost) return null

  // Try to calculate remaining from parsed values
  const parsedCost = parseCost(cost)
  const parsedPaid = amountPaid ? (parseCost(amountPaid) ?? { amount: parseFloat(amountPaid) }) : null
  const remaining = parsedCost && parsedPaid ? parsedCost.amount - parsedPaid.amount : null
  const convertedRemaining = convertedCost != null && convertedPaid != null ? convertedCost - convertedPaid : null

  // Whether the converted amount is in a different currency from what's in the cost string
  const showConverted = convertedCost != null && convertedCurrency && convertedCurrency !== parsedCost?.code

  if (!amountPaid) {
    // Simple mode — just show cost + converted
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

  // Full breakdown — total / paid / remaining
  return (
    <span className={`${className} inline-flex flex-col gap-0.5`}>
      <span>
        {cost}
        {showConverted && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.85em' }}>
            {' '}({formatAmount(convertedCost, convertedCurrency)})
          </span>
        )}
      </span>
      <span style={{ color: 'var(--text-faint)', fontSize: '0.85em' }}>
        Paid: {amountPaid}
        {convertedPaid != null && convertedCurrency && (
          <span> ({formatAmount(convertedPaid, convertedCurrency)})</span>
        )}
      </span>
      {remaining != null && remaining > 0 && (
        <span style={{ color: 'var(--warning)', fontSize: '0.85em' }}>
          Remaining: {parsedCost?.code ? formatAmount(remaining, parsedCost.code) : remaining.toFixed(2)}
          {convertedRemaining != null && convertedRemaining > 0 && convertedCurrency && (
            <span style={{ color: 'var(--text-faint)' }}> ({formatAmount(convertedRemaining, convertedCurrency)})</span>
          )}
        </span>
      )}
      {remaining != null && remaining <= 0 && (
        <span style={{ color: 'var(--success)', fontSize: '0.85em' }}>Fully paid ✓</span>
      )}
    </span>
  )
}
