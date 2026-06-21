import { formatAmount } from '../currency.js'

/**
 * Renders the original cost string, and if a converted amount is stored,
 * appends it in muted colour: e.g. "€450  (£375)"
 */
export default function CostDisplay({ item, className = '' }) {
  const cost = item?.cost
  const converted = item?.details?.converted_cost
  const convertedCurrency = item?.details?.converted_currency

  if (!cost) return null

  const showConverted = converted != null && convertedCurrency && convertedCurrency !== detectCode(cost)

  return (
    <span className={className}>
      {cost}
      {showConverted && (
        <span style={{ color: 'var(--text-faint)', fontSize: '0.85em' }}>
          {' '}({formatAmount(converted, convertedCurrency)})
        </span>
      )}
    </span>
  )
}

// Rough check — if the converted currency matches what's already in the cost string, skip showing it.
function detectCode(costStr) {
  const m = costStr?.match(/[A-Z]{3}/)
  return m ? m[0] : null
}
