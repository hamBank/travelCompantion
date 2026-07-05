import { formatCurrencyAmount, parseCost, getHomeCurrency } from '../currency.js'

/**
 * Renders cost information from stored values only — no API calls.
 *
 * Without amount_paid: inline  "€450 (£375)"
 * With amount_paid + compact:  "€450 (£375) · €225 outstanding (£190)"
 * With amount_paid + full:     block breakdown — Total / Paid / Outstanding rows
 *
 * Uses formatCurrencyAmount to disambiguate conflicting symbols (A$ vs US$).
 */
export default function CostDisplay({ item, className = '', showIcon = true, compact = false }) {
  const cost = item?.cost
  const d = item?.details ?? {}
  const amountPaid        = d.amount_paid
  const convertedCost     = d.converted_cost
  const convertedPaid     = d.converted_amount_paid
  const convertedCurrency = d.converted_currency

  if (!cost) return null

  const homeCode   = getHomeCurrency()
  const parsedCost = parseCost(cost, homeCode)
  const costCode   = parsedCost?.code ?? ''
  const showConverted = convertedCost != null && convertedCurrency && convertedCurrency !== costCode

  // Helper: format an amount in the cost's original currency (foreign — disambiguate vs home)
  const fmtCost = (amt) => formatCurrencyAmount(amt, costCode, homeCode)
  // Helper: format an amount in the home currency
  const fmtHome = (amt) => formatCurrencyAmount(amt, convertedCurrency, '')

  // ── No paid amount — simple inline ─────────────────────────────────────────
  if (!amountPaid) {
    return (
      <span className={className}>
        {showIcon && '💳 '}{cost}
        {showConverted && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.85em' }}>
            {' '}({fmtHome(convertedCost)})
          </span>
        )}
      </span>
    )
  }

  // ── Shared calculations ─────────────────────────────────────────────────────
  const parsedPaid = parseCost(amountPaid, homeCode) ?? { amount: parseFloat(amountPaid) ?? 0, code: costCode }
  const outstanding         = parsedCost && parsedPaid.amount != null ? parsedCost.amount - parsedPaid.amount : null
  const convertedOutstanding = convertedCost != null && convertedPaid != null
    ? Math.round((convertedCost - convertedPaid) * 100) / 100 : null
  const fullyPaid = outstanding != null && outstanding <= 0

  // ── Compact inline (for cards) ──────────────────────────────────────────────
  if (compact) {
    return (
      <span className={className}>
        {showIcon && '💳 '}{cost}
        {showConverted && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.85em' }}>
            {' '}({fmtHome(convertedCost)})
          </span>
        )}
        {fullyPaid
          ? <span style={{ color: 'var(--success)', fontSize: '0.85em' }}> ✓</span>
          : outstanding != null && outstanding > 0 && (
            <span style={{ color: 'var(--warning)', fontSize: '0.85em' }}>
              {' · '}{fmtCost(outstanding)}
              {convertedOutstanding != null && convertedOutstanding > 0 && convertedCurrency && (
                <span style={{ color: 'var(--text-faint)' }}> ({fmtHome(convertedOutstanding)})</span>
              )}
              {' outstanding'}
            </span>
          )
        }
      </span>
    )
  }

  // ── Full block breakdown (for detail views) ─────────────────────────────────
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>

      <div className="flex items-baseline gap-1.5 flex-wrap">
        {showIcon && <span>💳</span>}
        <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>Total</span>
        <span>{cost}</span>
        {showConverted && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>({fmtHome(convertedCost)})</span>
        )}
      </div>

      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>Paid</span>
        <span>{amountPaid}</span>
        {convertedPaid != null && convertedCurrency && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>({fmtHome(convertedPaid)})</span>
        )}
      </div>

      {fullyPaid ? (
        <div>
          <span style={{ color: 'var(--success)', fontSize: '0.8em' }}>Fully paid ✓</span>
        </div>
      ) : outstanding != null && outstanding > 0 ? (
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>Outstanding</span>
          <span style={{ color: 'var(--warning)', fontWeight: 500 }}>{fmtCost(outstanding)}</span>
          {convertedOutstanding != null && convertedOutstanding > 0 && convertedCurrency && (
            <span style={{ color: 'var(--text-faint)', fontSize: '0.8em' }}>({fmtHome(convertedOutstanding)})</span>
          )}
        </div>
      ) : null}

    </div>
  )
}
