import { useState } from 'react'
import { HOME_CURRENCY_KEY } from '../currency.js'
import { useState as useReactState, useEffect } from 'react'
import { getHideCompleted, setHideCompleted, getShowInbound, setShowInbound, getHideStopFrames, setHideStopFrames, getDefaultToToday, setDefaultToToday, getFontScale, setFontScale, FONT_SCALE_OPTIONS } from '../settings.js'
import { getImportAddress, regenerateImportAddress, getApiTokens, createApiToken, revokeApiToken } from '../api.js'
import { isPushSupported, getPushEnabled, enablePush, disablePush, showLocalTestNotification } from '../push.js'
import { fmtDay } from '../dates.js'
import Toggle from './Toggle.jsx'

function NotificationsSection() {
  const [enabled, setEnabled] = useReactState(getPushEnabled)
  const [busy, setBusy] = useReactState(false)
  const [error, setError] = useReactState(null)
  const [localTestResult, setLocalTestResult] = useReactState(null)
  const supported = isPushSupported()

  async function toggle() {
    if (busy) return
    setBusy(true); setError(null)
    try {
      if (enabled) { await disablePush(); setEnabled(false) }
      else { await enablePush(); setEnabled(true) }
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function testLocal() {
    setLocalTestResult(null); setError(null)
    try { await showLocalTestNotification(); setLocalTestResult('Requested — check now for a "Local test" notification.') }
    catch (e) { setLocalTestResult(null); setError(e.message) }
  }

  return (
    <div className="space-y-2">
      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">Notifications</p>
      <p style={{ color: 'var(--text-muted)' }} className="text-xs">
        Alerts when online check-in opens for a flight, or a train/transfer's departure is approaching.
        This is a per-device setting — enable it separately on each phone or browser you use.
      </p>
      {supported ? (
        <>
          <Toggle label={busy ? 'Working…' : (enabled ? 'Notifications on for this device' : 'Enable notifications on this device')} on={enabled} onToggle={toggle} />
          <button
            onClick={testLocal}
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            className="w-full text-xs px-3 py-2 rounded-lg hover:opacity-80 transition-opacity"
          >
            Send local test notification (no server involved)
          </button>
          {localTestResult && <p style={{ color: 'var(--success)' }} className="text-xs">{localTestResult}</p>}
        </>
      ) : (
        <p style={{ color: 'var(--text-faint)' }} className="text-xs">Not supported on this browser/device.</p>
      )}
      {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}
    </div>
  )
}

function ImportAddress() {
  const [addr, setAddr] = useReactState(null)
  const [copied, setCopied] = useReactState(false)
  const [regenerating, setRegenerating] = useReactState(false)
  const [confirming, setConfirming] = useReactState(false)
  const [error, setError] = useReactState(null)
  useEffect(() => { getImportAddress().then(r => setAddr(r.address)).catch(() => {}) }, [])
  if (!addr) return null
  function copy() {
    navigator.clipboard?.writeText(addr).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }
  async function regenerate() {
    setRegenerating(true); setError(null)
    try {
      const r = await regenerateImportAddress()
      setAddr(r.address)
      setConfirming(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setRegenerating(false)
    }
  }
  return (
    <div>
      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-1">Forward bookings by email</p>
      <p style={{ color: 'var(--text-muted)' }} className="text-xs mb-2">
        Forward any booking confirmation here and it'll appear in your pending imports to review.
      </p>
      <div className="flex items-center gap-2">
        <code style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }} className="flex-1 rounded-lg px-2 py-1.5 text-xs break-all">{addr}</code>
        <button onClick={copy} style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }} className="text-xs px-2 py-1.5 rounded-lg hover:opacity-80 transition-opacity shrink-0">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 mt-2">
          <span style={{ color: 'var(--text-muted)' }} className="text-xs flex-1">
            The old address stops working immediately. Continue?
          </span>
          <button
            onClick={() => setConfirming(false)}
            disabled={regenerating}
            style={{ color: 'var(--text-faint)' }}
            className="text-xs hover:opacity-70 transition-opacity"
          >
            Never mind
          </button>
          <button
            onClick={regenerate}
            disabled={regenerating}
            style={{ color: 'var(--error)', border: '1px solid color-mix(in srgb, var(--error) 35%, transparent)' }}
            className="text-xs px-2 py-1.5 rounded-lg hover:opacity-80 transition-opacity disabled:opacity-50 shrink-0"
          >
            {regenerating ? 'Regenerating…' : 'Confirm'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          style={{ color: 'var(--text-faint)' }}
          className="text-xs hover:opacity-70 transition-opacity mt-1.5 underline"
        >
          Regenerate address
        </button>
      )}
      {error && <p style={{ color: 'var(--error)' }} className="text-xs mt-1">{error}</p>}
    </div>
  )
}

// Personal access tokens for programmatic API use (scripts, agents) — see
// docs/programmatic-api.md. Mirrors ImportAddress's shape: list what exists,
// offer to create/regenerate, and make the one-time secret easy to copy.
function ApiTokensSection() {
  const [tokens, setTokens] = useReactState(null)
  const [label, setLabel] = useReactState('')
  const [creating, setCreating] = useReactState(false)
  const [justCreated, setJustCreated] = useReactState(null)  // { token, label } — shown once
  const [copied, setCopied] = useReactState(false)
  const [revoking, setRevoking] = useReactState(null)  // id mid-revoke
  const [error, setError] = useReactState(null)

  function load() { Promise.resolve(getApiTokens()).then(setTokens).catch(() => {}) }
  useEffect(load, [])

  async function create() {
    setCreating(true); setError(null)
    try {
      const r = await createApiToken(label.trim() ? { label: label.trim() } : {})
      setJustCreated({ token: r.token, label: r.label })
      setLabel('')
      setCopied(false)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  function copy() {
    navigator.clipboard?.writeText(justCreated.token)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => {})
  }

  async function revoke(id) {
    setRevoking(id); setError(null)
    try {
      await revokeApiToken(id)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div>
      <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-1">API access tokens</p>
      <p style={{ color: 'var(--text-muted)' }} className="text-xs mb-2">
        For scripts or agents creating trips on your behalf — see docs/programmatic-api.md.
        Grants the same full access as signing in; treat it like a password.
      </p>

      {justCreated && (
        <div
          style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)' }}
          className="rounded-lg p-2.5 mb-2"
        >
          <p style={{ color: 'var(--warning)' }} className="text-xs font-medium mb-1.5">
            Copy this now — it won't be shown again{justCreated.label ? ` (“${justCreated.label}”)` : ''}.
          </p>
          <div className="flex items-center gap-2">
            <code style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }} className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-xs break-all">
              {justCreated.token}
            </code>
            <button onClick={copy} style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }} className="text-xs px-2 py-1.5 rounded-lg hover:opacity-80 transition-opacity shrink-0">
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {tokens?.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {tokens.map(t => (
            <div
              key={t.id}
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
              className="rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs"
            >
              <div className="min-w-0">
                <div style={{ color: 'var(--text)' }} className="font-medium truncate">{t.label || 'Unlabeled token'}</div>
                <div style={{ color: 'var(--text-faint)' }}>
                  {t.revoked_at ? 'Revoked' : t.expires_at ? `Expires ${fmtDay(t.expires_at)}` : 'No expiry'}
                </div>
              </div>
              {!t.revoked_at && (
                <button
                  onClick={() => revoke(t.id)}
                  disabled={revoking === t.id}
                  style={{ color: 'var(--error)' }}
                  className="hover:opacity-70 transition-opacity disabled:opacity-50 shrink-0"
                >
                  {revoking === t.id ? 'Revoking…' : 'Revoke'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Label (optional)"
          style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
          className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={create}
          disabled={creating}
          style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
          className="text-xs px-2 py-1.5 rounded-lg hover:opacity-80 transition-opacity disabled:opacity-50 shrink-0"
        >
          {creating ? 'Creating…' : 'Create token'}
        </button>
      </div>
      {error && <p style={{ color: 'var(--error)' }} className="text-xs mt-1">{error}</p>}
    </div>
  )
}

const COMMON_CURRENCIES = [
  'AED', 'ARS', 'AUD', 'BDT', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY',
  'COP', 'CZK', 'DKK', 'EGP', 'EUR', 'GBP', 'GHS', 'HKD', 'HUF',
  'IDR', 'ILS', 'INR', 'JPY', 'KES', 'KRW', 'KWD', 'LKR', 'MXN',
  'MYR', 'NGN', 'NOK', 'NZD', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR',
  'RON', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'TZS',
  'UAH', 'USD', 'VND', 'ZAR',
]

export default function UserSettings({ onClose }) {
  const [currency, setCurrency] = useState(
    () => localStorage.getItem(HOME_CURRENCY_KEY) || ''
  )
  const [filter, setFilter] = useState('')
  const [hideCompleted, setHideCompletedState] = useState(getHideCompleted)
  const [showInbound, setShowInboundState] = useState(getShowInbound)
  const [hideStopFrames, setHideStopFramesState] = useState(getHideStopFrames)
  const [defaultToToday, setDefaultToTodayState] = useState(getDefaultToToday)
  const [fontScale, setFontScaleState] = useState(getFontScale)

  function save() {
    if (currency) localStorage.setItem(HOME_CURRENCY_KEY, currency)
    else localStorage.removeItem(HOME_CURRENCY_KEY)
    setHideCompleted(hideCompleted)
    setShowInbound(showInbound)
    setHideStopFrames(hideStopFrames)
    setDefaultToToday(defaultToToday)
    setFontScale(fontScale)
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
            <Toggle label="Hide stop headers and frames" on={hideStopFrames} onToggle={() => setHideStopFramesState(v => !v)} />
            <Toggle label="Open trips in Today view by default" on={defaultToToday} onToggle={() => setDefaultToTodayState(v => !v)} />
            <div className="flex items-center justify-between">
              <span style={{ color: 'var(--text-muted)' }} className="text-sm">Text size</span>
              <div className="flex gap-1">
                {FONT_SCALE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => { setFontScaleState(opt.value); setFontScale(opt.value) }}
                    style={{
                      background: fontScale === opt.value ? 'var(--accent)' : 'var(--surface)',
                      color: fontScale === opt.value ? 'var(--accent-fg)' : 'var(--text-muted)',
                      border: `1px solid ${fontScale === opt.value ? 'var(--accent)' : 'var(--border)'}`,
                      fontSize: '0.7rem',
                    }}
                    className="px-2 py-1 rounded font-medium transition-colors"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <NotificationsSection />

          <ImportAddress />

          <ApiTokensSection />

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
