import { useState } from 'react'
import { createTrip } from '../api.js'

function fromDateInput(val) { return val ? val + 'T00:00:00' : null }

export default function CreateTripModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [budget, setBudget] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const inputStyle = { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }

  async function create() {
    if (saving) return
    const trimmed = name.trim()
    if (!trimmed) { setError('Trip name is required'); return }
    if (startDate && endDate && endDate < startDate) {
      setError('End date cannot be before start date'); return
    }
    setError(null); setSaving(true)
    try {
      const trip = await createTrip({
        name: trimmed,
        start_date: fromDateInput(startDate),
        end_date: fromDateInput(endDate),
        budget: budget.trim() || null,
      })
      onCreated(trip)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', maxHeight: '80vh' }}
        className="w-full max-w-md rounded-2xl flex flex-col overflow-hidden"
      >
        <div style={{ borderBottom: '1px solid var(--border)' }} className="flex items-center justify-between px-5 py-4">
          <div style={{ color: 'var(--text)' }} className="font-medium text-sm">Create a new trip</div>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="hover:opacity-70 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label htmlFor="trip-name" style={{ color: 'var(--text-faint)' }} className="block text-xs uppercase tracking-wide mb-1.5">
              Trip name
            </label>
            <input
              id="trip-name"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()}
              placeholder="e.g. Europe 2026"
              style={inputStyle}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="trip-start" style={{ color: 'var(--text-faint)' }} className="block text-xs uppercase tracking-wide mb-1.5">
                Start date
              </label>
              <input
                id="trip-start"
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                style={inputStyle}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label htmlFor="trip-end" style={{ color: 'var(--text-faint)' }} className="block text-xs uppercase tracking-wide mb-1.5">
                End date
              </label>
              <input
                id="trip-end"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={e => setEndDate(e.target.value)}
                style={inputStyle}
                className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="trip-budget" style={{ color: 'var(--text-faint)' }} className="block text-xs uppercase tracking-wide mb-1.5">
              Budget <span style={{ textTransform: 'none' }}>(optional)</span>
            </label>
            <input
              id="trip-budget"
              value={budget}
              onChange={e => setBudget(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()}
              placeholder="e.g. 5000 AUD"
              style={inputStyle}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </div>

          {error && (
            <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} className="flex items-center justify-end gap-3 px-5 py-4">
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-sm hover:opacity-70">Cancel</button>
          <button
            onClick={create}
            disabled={saving}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            {saving ? 'Creating…' : 'Create trip'}
          </button>
        </div>
      </div>
    </div>
  )
}
