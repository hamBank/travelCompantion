import { useState } from 'react'
import { createExpense, updateExpense } from '../api.js'
import { parseCost, convertCurrency, getHomeCurrency } from '../currency.js'

// Today's date as an input[type=date] value, in the *local* device day —
// matches how a user thinks about "when did I spend this", not UTC.
function todayLocalDate() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

/**
 * Quick-add / edit form for an actual logged Expense (issue #59) — amount,
 * short name, date, optional notes, and an optional link to an existing
 * item (only offered when `items` is non-empty; used for the plan-vs-actual
 * rollup in BudgetSummary). Deliberately the SAME component whether opened
 * from a StopCard (pre-filled with that stop's id) or from the Budget modal
 * (no stop pre-filled, full item list offered) — one form, two entry points,
 * per the "quick-add from the stop card AND a fuller form in Budget" answer.
 */
export default function ExpenseQuickAdd({ tripId, stopId = null, items = [], expense = null, onSaved, onClose }) {
  const isEdit = !!expense
  const [name, setName] = useState(expense?.name ?? '')
  const [amount, setAmount] = useState(expense?.amount ?? '')
  const [date, setDate] = useState(expense?.occurred_at?.slice(0, 10) || todayLocalDate())
  const [itemId, setItemId] = useState(expense?.item_id ?? '')
  const [notes, setNotes] = useState(expense?.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save() {
    if (!name.trim() || !amount.trim() || saving) return
    setSaving(true); setError(null)
    try {
      // Same fallback as BudgetSummary's `home` -- if these two ever disagreed,
      // a just-logged expense's converted_currency wouldn't match what
      // BudgetSummary treats as home, and aggregateExpenses would silently
      // bucket a brand-new expense into staleConversion immediately.
      const home = getHomeCurrency() || 'AUD'
      const parsed = parseCost(amount, home)
      if (!parsed) {
        setError("Couldn't recognize a currency amount (e.g. \"500 THB\", \"$20\")")
        setSaving(false)
        return
      }
      const convertedAmount = parsed.code === home
        ? parsed.amount
        : await convertCurrency(parsed.amount, parsed.code, home)

      const body = {
        name: name.trim(),
        amount: amount.trim(),
        occurred_at: `${date}T00:00:00`,
        notes: notes.trim(),
        stop_id: stopId,
        item_id: itemId ? Number(itemId) : null,
        converted_amount: convertedAmount,
        converted_currency: home,
      }
      const saved = isEdit ? await updateExpense(expense.id, body) : await createExpense(tripId, body)
      onSaved?.(saved)
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)' }} className="w-full max-w-sm rounded-2xl overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text)' }} className="text-sm font-semibold">💵 {isEdit ? 'Edit expense' : 'Log expense'}</span>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-sm hover:opacity-70">✕</button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <div className="flex gap-2">
            <input
              value={amount} onChange={e => setAmount(e.target.value)} placeholder="Amount (e.g. 500 THB)"
              autoFocus
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
              className="flex-1 min-w-0 text-sm px-2.5 py-1.5 rounded-lg"
            />
            <input
              type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
              className="text-sm px-2.5 py-1.5 rounded-lg"
            />
          </div>
          <input
            value={name} onChange={e => setName(e.target.value)} placeholder="What was it for?"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
            className="w-full text-sm px-2.5 py-1.5 rounded-lg"
          />
          {items.length > 0 && (
            <label className="block">
              <span style={{ color: 'var(--text-muted)' }} className="text-xs">Link to a planned item (optional)</span>
              <select
                value={itemId} onChange={e => setItemId(e.target.value)}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                className="w-full text-sm px-2.5 py-1.5 rounded-lg mt-0.5"
              >
                <option value="">Not linked</option>
                {items.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
              </select>
            </label>
          )}
          <textarea
            value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
            className="w-full text-sm px-2.5 py-1.5 rounded-lg resize-none"
            rows={2}
          />
          {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}
        </div>

        <div className="px-4 py-3 flex justify-end gap-2" style={{ borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose} style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }} className="text-xs px-3 py-1.5 rounded-lg hover:opacity-80">Cancel</button>
          <button
            onClick={save} disabled={saving || !name.trim() || !amount.trim()}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="text-xs px-3 py-1.5 rounded-lg font-medium hover:opacity-80 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
