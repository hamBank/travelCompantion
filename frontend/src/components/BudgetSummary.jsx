import { aggregateSpend } from '../budget.js'
import { formatCurrencyAmount, getHomeCurrency } from '../currency.js'
import { KIND_LABEL } from '../kinds.js'

export default function BudgetSummary({ trip, stops, onClose }) {
  const home = getHomeCurrency() || 'AUD'
  const items = (stops ?? []).flatMap(s => s.items ?? [])
  const { planned, paid, byKind, byCurrency, unconvertible, noRecognizableCost } = aggregateSpend(items, home)

  const budget = trip?.budget ? parseFloat(trip.budget) : null
  const budgetValid = budget != null && !Number.isNaN(budget) && budget > 0
  const pct = budgetValid ? Math.min(100, Math.round((planned / budget) * 100)) : 0
  const overBudget = budgetValid && planned > budget

  const fmt = (amt) => formatCurrencyAmount(amt, home)

  const kindRows = Object.entries(byKind).sort((a, b) => b[1].planned - a[1].planned)

  // Home currency first (it's what you'll be topping up most often), then the
  // rest ordered by how much of each you'll need.
  const currencyRows = Object.entries(byCurrency).sort(([codeA], [codeB]) => {
    if (codeA === home) return -1
    if (codeB === home) return 1
    return byCurrency[codeB].planned - byCurrency[codeA].planned
  })

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)' }} className="w-full max-w-md rounded-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">💰 Budget</span>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-sm hover:opacity-70">✕</button>
        </div>

        <div className="px-4 py-4 space-y-4 overflow-y-auto">
          {!budgetValid && (
            <p style={{ color: 'var(--text-faint)' }} className="text-xs">
              No budget set for this trip yet — add one from the Edit tab to track spend against a target.
            </p>
          )}

          {budgetValid && (
            <div>
              <div className="flex items-baseline justify-between mb-1">
                <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">
                  {fmt(planned)} / {fmt(budget)} planned
                </span>
                <span style={{ color: overBudget ? 'var(--error)' : 'var(--text-faint)' }} className="text-xs">
                  {pct}%
                </span>
              </div>
              <div style={{ background: 'var(--surface-2)', borderRadius: '999px', height: '6px' }}>
                <div style={{
                  width: `${pct}%`,
                  background: overBudget ? 'var(--error)' : 'var(--accent)',
                  height: '100%', borderRadius: '999px', transition: 'width .2s',
                }} />
              </div>
              {overBudget && (
                <p style={{ color: 'var(--error)' }} className="text-xs mt-1">
                  Over budget by {fmt(planned - budget)}
                </p>
              )}
            </div>
          )}

          <div className="flex items-baseline justify-between">
            <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Total planned</span>
            <span style={{ color: 'var(--text)' }} className="text-sm">{fmt(planned)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Total paid</span>
            <span style={{ color: 'var(--text)' }} className="text-sm">{fmt(paid)}</span>
          </div>

          {kindRows.length > 0 && (
            <div>
              <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide block mb-1.5">By category</span>
              <table className="w-full text-xs">
                <tbody>
                  {kindRows.map(([kind, sums]) => (
                    <tr key={kind}>
                      <td style={{ color: 'var(--text-muted)' }} className="py-0.5">{KIND_LABEL[kind] ?? kind}</td>
                      <td style={{ color: 'var(--text)' }} className="py-0.5 text-right">{fmt(sums.planned)}</td>
                      <td style={{ color: 'var(--text-faint)' }} className="py-0.5 text-right pl-2">paid {fmt(sums.paid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {currencyRows.length > 0 && (
            <div>
              <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide block mb-1.5">By currency</span>
              <table className="w-full text-xs">
                <tbody>
                  {currencyRows.map(([code, sums]) => {
                    const outstanding = sums.planned - sums.paid
                    return (
                      <tr key={code}>
                        <td style={{ color: 'var(--text-muted)' }} className="py-0.5">
                          {code}{code === home && <span style={{ color: 'var(--text-faint)' }}> (home)</span>}
                        </td>
                        <td style={{ color: 'var(--text)' }} className="py-0.5 text-right">
                          {formatCurrencyAmount(sums.planned, code, home)}
                        </td>
                        <td style={{ color: 'var(--text-faint)' }} className="py-0.5 text-right pl-2">
                          {outstanding > 0
                            ? `${formatCurrencyAmount(outstanding, code, home)} left`
                            : 'settled'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {unconvertible.length > 0 && (
            <p style={{ color: 'var(--text-faint)' }} className="text-xs">
              Not included in the home-currency totals above ({unconvertible.length} item{unconvertible.length === 1 ? '' : 's'} — see
              the currency they're actually in under "By currency"): {unconvertible.join(', ')}
            </p>
          )}

          {noRecognizableCost.length > 0 && (
            <p style={{ color: 'var(--text-faint)' }} className="text-xs">
              Not included anywhere above — no recognisable cost amount ({noRecognizableCost.length} item{noRecognizableCost.length === 1 ? '' : 's'}): {noRecognizableCost.join(', ')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
