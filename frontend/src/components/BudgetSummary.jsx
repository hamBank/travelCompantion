import { useState, useEffect } from 'react'
import { aggregateSpend, aggregateExpenses } from '../budget.js'
import { formatCurrencyAmount, getHomeCurrency } from '../currency.js'
import { KIND_LABEL } from '../kinds.js'
import { listExpenses, deleteExpense as apiDeleteExpense } from '../api.js'
import ExpenseQuickAdd from './ExpenseQuickAdd.jsx'

export default function BudgetSummary({ trip, stops, canEdit = true, onClose }) {
  const home = getHomeCurrency() || 'AUD'
  const items = (stops ?? []).flatMap(s => s.items ?? [])
  const { planned, paid, byKind, byCurrency, unconvertible, noRecognizableCost } = aggregateSpend(items, home)
  const [expandedCurrency, setExpandedCurrency] = useState(null)

  const [expenses, setExpenses] = useState([])
  const [showAddExpense, setShowAddExpense] = useState(false)
  const [editingExpense, setEditingExpense] = useState(null)

  function refreshExpenses() {
    if (trip?.id) listExpenses(trip.id).then(setExpenses).catch(() => {})
  }
  useEffect(() => { refreshExpenses() }, [trip?.id])

  const { total: actualTotal, byDay, byStop, byItem, staleConversion } = aggregateExpenses(expenses, items, home)
  const stopName = stopId => stops?.find(s => String(s.id) === stopId)?.location || 'No stop'
  const dayRows = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))
  const stopRows = Object.entries(byStop).sort(([a], [b]) => stopName(a).localeCompare(stopName(b)))
  const itemRows = Object.entries(byItem)

  async function removeExpense(id) {
    await apiDeleteExpense(id)
    refreshExpenses()
  }

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
              <div className="flex items-baseline gap-1.5 mb-1.5">
                <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">By currency</span>
                <span style={{ color: 'var(--text-faint)' }} className="text-xs">(tap a row to see which items)</span>
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {currencyRows.flatMap(([code, sums]) => {
                    const outstanding = sums.planned - sums.paid
                    const expanded = expandedCurrency === code
                    const rows = [
                      <tr
                        key={code}
                        onClick={() => setExpandedCurrency(expanded ? null : code)}
                        className="cursor-pointer"
                      >
                        <td style={{ color: 'var(--text-muted)' }} className="py-0.5">
                          <span style={{ color: 'var(--text-faint)', fontSize: '0.6rem' }}>{expanded ? '▾' : '▸'}</span>{' '}
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
                      </tr>,
                    ]
                    if (expanded) {
                      rows.push(...sums.items.map(it => (
                        <tr key={`${code}-${it.name}`}>
                          <td style={{ color: 'var(--text-faint)' }} className="py-0.5 pl-4">{it.name}</td>
                          <td style={{ color: 'var(--text-faint)' }} className="py-0.5 text-right">
                            {formatCurrencyAmount(it.planned, code, home)}
                          </td>
                          <td style={{ color: 'var(--text-faint)' }} className="py-0.5 text-right pl-2">
                            {it.paid > 0 ? `paid ${formatCurrencyAmount(it.paid, code, home)}` : ''}
                          </td>
                        </tr>
                      )))
                    }
                    return rows
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

          {/* Actual logged spend (issue #59) — distinct from the planned/paid
              rollup above, which comes from each item's own cost/amount_paid
              fields. This section tracks real, point-in-time Expense rows. */}
          <div style={{ borderTop: '1px solid var(--border)' }} className="pt-3 space-y-3">
            <div className="flex items-baseline justify-between">
              <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Actual spend logged</span>
              <span style={{ color: 'var(--text)' }} className="text-sm">{fmt(actualTotal)}</span>
            </div>

            {canEdit && (
              <button
                onClick={() => setShowAddExpense(true)}
                style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
                className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80"
              >
                + Log expense
              </button>
            )}

            {dayRows.length > 0 && (
              <div>
                <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide block mb-1.5">By day</span>
                <table className="w-full text-xs">
                  <tbody>
                    {dayRows.map(([day, amt]) => (
                      <tr key={day}>
                        <td style={{ color: 'var(--text-muted)' }} className="py-0.5">{day}</td>
                        <td style={{ color: 'var(--text)' }} className="py-0.5 text-right">{fmt(amt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {stopRows.length > 0 && (
              <div>
                <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide block mb-1.5">By stop</span>
                <table className="w-full text-xs">
                  <tbody>
                    {stopRows.map(([stopId, sums]) => (
                      <tr key={stopId || 'none'}>
                        <td style={{ color: 'var(--text-muted)' }} className="py-0.5">{stopName(stopId)}</td>
                        <td style={{ color: 'var(--text)' }} className="py-0.5 text-right">{fmt(sums.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {itemRows.length > 0 && (
              <div>
                <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide block mb-1.5">Plan vs actual</span>
                <table className="w-full text-xs">
                  <tbody>
                    {itemRows.map(([itemId, sums]) => (
                      <tr key={itemId}>
                        <td style={{ color: 'var(--text-muted)' }} className="py-0.5">{sums.name}</td>
                        <td style={{ color: 'var(--text-faint)' }} className="py-0.5 text-right">
                          {sums.planned != null ? `planned ${fmt(sums.planned)}` : ''}
                        </td>
                        <td
                          style={{ color: sums.planned != null && sums.actual > sums.planned ? 'var(--error)' : 'var(--text)' }}
                          className="py-0.5 text-right pl-2"
                        >
                          actual {fmt(sums.actual)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {expenses.length > 0 && (
              <div>
                <span style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide block mb-1.5">All logged expenses</span>
                <div className="space-y-1">
                  {expenses.map(exp => (
                    <div key={exp.id} className="flex items-center gap-2 text-xs group">
                      <button
                        onClick={() => canEdit && setEditingExpense(exp)}
                        className="flex-1 min-w-0 text-left truncate hover:opacity-80"
                        style={{ color: 'var(--text-muted)' }}
                        disabled={!canEdit}
                      >
                        {String(exp.occurred_at).slice(0, 10)} — {exp.name}
                      </button>
                      <span style={{ color: 'var(--text)' }} className="shrink-0">
                        {exp.converted_amount != null && exp.converted_currency === home
                          ? fmt(exp.converted_amount)
                          : exp.amount}
                      </span>
                      {canEdit && (
                        <button
                          onClick={() => removeExpense(exp.id)}
                          style={{ color: 'var(--text-faint)' }}
                          className="shrink-0 hover:opacity-70"
                          title="Delete expense"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {staleConversion.length > 0 && (
              <p style={{ color: 'var(--text-faint)' }} className="text-xs">
                {staleConversion.length} logged expense{staleConversion.length === 1 ? '' : 's'} not included above —
                home currency changed since they were logged. Edit and re-save to refresh the conversion.
              </p>
            )}
          </div>
        </div>
      </div>

      {(showAddExpense || editingExpense) && (
        <ExpenseQuickAdd
          tripId={trip?.id}
          items={items}
          expense={editingExpense}
          onSaved={refreshExpenses}
          onClose={() => { setShowAddExpense(false); setEditingExpense(null) }}
        />
      )}
    </div>
  )
}
