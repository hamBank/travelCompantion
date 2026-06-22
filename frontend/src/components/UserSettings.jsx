import { useState } from 'react'
import { HOME_CURRENCY_KEY } from '../currency.js'
import { getHideCompleted, setHideCompleted, getShowInbound, setShowInbound } from '../settings.js'

const COMMON_CURRENCIES = [
  'AED', 'ARS', 'AUD', 'BDT', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY',
  'COP', 'CZK', 'DKK', 'EGP', 'EUR', 'GBP', 'GHS', 'HKD', 'HUF',
  'IDR', 'ILS', 'INR', 'JPY', 'KES', 'KRW', 'KWD', 'LKR', 'MXN',
  'MYR', 'NGN', 'NOK', 'NZD', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR',
  'RON', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'TZS',
  'UAH', 'USD', 'VND', 'ZAR',
]

function Toggle({ label, on, onToggle }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
    >
      <span style={{ color: 'var(--text)' }} className="text-sm text-left">{label}</span>
      <span
        style={{
          width: '2.5rem', height: '1.4rem', borderRadius: '9999px', flexShrink: 0, position: 'relative',
          background: on ? 'var(--accent)' : 'var(--border)', transition: 'background 0.15s',
        }}
      >
        <span style={{
          position: 'absolute', top: '0.15rem', left: on ? '1.25rem' : '0.15rem',
          width: '1.1rem', height: '1.1rem', borderRadius: '9999px', background: '#fff',
          transition: 'left 0.15s',
        }} />
      </span>
    </button>
  )
}

export default function UserSettings({ onClose }) {
  const [currency, setCurrency] = useState(
    () => localStorage.getItem(HOME_CURRENCY_KEY) || ''
  )
  const [filter, setFilter] = useState('')
  const [hideCompleted, setHideCompletedState] = useState(getHideCompleted)
  const [showInbound, setShowInboundState] = useState(getShowInbound)

  function save() {
    if (currency) localStorage.setItem(HOME_CURRENCY_KEY, currency)
    else localStorage.removeItem(HOME_CURRENCY_KEY)
    setHideCompleted(hideCompleted)
    setShowInbound(showInbound)
    onClose()
  }

  const filtered = COMMON_CURRENCIES.filter(c =>
    !filter || c.includes(filter.toUpperCase())
  )

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50 p-4"
      style={{ background: 'var(--overlay)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border)', maxHeight: '80vh' }}
        className="w-full max-w-sm rounded-2xl flex flex-col overflow-hidden"
      >
        <div style={{ borderBottom: '1px solid var(--border)' }} className="flex items-center justify-between px-5 py-4">
          <span style={{ color: 'var(--text)' }} className="font-medium text-sm">Settings</span>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="hover:opacity-70 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="space-y-2">
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Display</p>
            <Toggle label="Hide completed items" on={hideCompleted} onToggle={() => setHideCompletedState(v => !v)} />
            <Toggle label="Show inbound flight/train on destination stop" on={showInbound} onToggle={() => setShowInboundState(v => !v)} />
          </div>

          <div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-1">Home currency</p>
            <p style={{ color: 'var(--text-muted)' }} className="text-xs mb-3">
              Costs will be converted to this currency and shown alongside the original.
            </p>

            {currency && (
              <div
                style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
                className="rounded-lg px-3 py-2 mb-3 flex items-center justify-between"
              >
                <span style={{ color: 'var(--accent)' }} className="text-sm font-medium">{currency} selected</span>
                <button
                  onClick={() => setCurrency('')}
                  style={{ color: 'var(--text-faint)' }}
                  className="text-xs hover:opacity-70"
                >
                  Clear
                </button>
              </div>
            )}

            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter currencies…"
              style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)] mb-2"
            />

            <div className="grid grid-cols-3 gap-1.5">
              {filtered.map(c => (
                <button
                  key={c}
                  onClick={() => setCurrency(c)}
                  style={{
                    background: currency === c
                      ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                      : 'var(--surface-2)',
                    border: `1px solid ${currency === c ? 'var(--accent)' : 'var(--border)'}`,
                    color: currency === c ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                  className="rounded-lg px-2 py-1.5 text-xs font-medium hover:opacity-80 transition-opacity"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} className="flex justify-end gap-3 px-5 py-4">
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="text-sm hover:opacity-70">Cancel</button>
          <button
            onClick={save}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
