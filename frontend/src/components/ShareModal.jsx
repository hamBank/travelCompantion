import { useState, useEffect } from 'react'
import { getTripMembers, addTripMember, removeTripMember, getCalendarUrl } from '../api.js'

const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' }

export default function ShareModal({ trip, onClose }) {
  const [members, setMembers] = useState(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [calBusy, setCalBusy] = useState(false)
  const [calCopied, setCalCopied] = useState(false)
  const [calError, setCalError] = useState(null)

  async function load() {
    try { setMembers(await getTripMembers(trip.id)) }
    catch (e) { setError(e.message) }
  }
  useEffect(() => { load() }, [trip.id])

  async function add() {
    const e = email.trim()
    if (!e || busy) return
    setBusy(true); setError(null)
    try {
      await addTripMember(trip.id, e, role)
      setEmail('')
      await load()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }

  async function remove(memberEmail) {
    setError(null)
    try { await removeTripMember(trip.id, memberEmail); await load() }
    catch (err) { setError(err.message) }
  }

  async function copyCalendarUrl() {
    if (calBusy) return
    setCalBusy(true); setCalError(null)
    try {
      const { url } = await getCalendarUrl(trip.id)
      const absolute = `${window.location.origin}${url}`
      await navigator.clipboard?.writeText(absolute)
      setCalCopied(true)
      setTimeout(() => setCalCopied(false), 1500)
    } catch (err) { setCalError(err.message) }
    finally { setCalBusy(false) }
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
          <div>
            <div style={{ color: 'var(--text)' }} className="font-medium text-sm">Share trip</div>
            <div style={{ color: 'var(--text-faint)' }} className="text-xs mt-0.5 truncate">{trip.name}</div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--text-faint)' }} className="hover:opacity-70 text-lg leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Add person */}
          <div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">Invite by email</p>
            <div className="flex gap-2">
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && add()}
                placeholder="person@gmail.com"
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="flex-1 rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              />
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)' }}
                className="rounded-lg px-2 py-2 text-sm outline-none"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button
                onClick={add}
                disabled={busy || !email.trim()}
                style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                Add
              </button>
            </div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs mt-1.5">
              They must sign in with this Google account to gain access.
            </p>
          </div>

          {error && <p style={{ color: 'var(--error)' }} className="text-xs">{error}</p>}

          {/* Members list */}
          <div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">People with access</p>
            {!members && <p style={{ color: 'var(--text-faint)' }} className="text-xs">Loading…</p>}
            <div className="space-y-1.5">
              {members?.map(m => (
                <div
                  key={m.user_email}
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                  className="rounded-lg px-3 py-2 flex items-center gap-2"
                >
                  <span style={{ color: 'var(--text)' }} className="text-sm flex-1 min-w-0 truncate">{m.user_email}</span>
                  <span
                    style={{
                      color: m.role === 'owner' ? 'var(--accent)' : 'var(--text-muted)',
                      border: '1px solid var(--border)',
                    }}
                    className="text-xs px-2 py-0.5 rounded-full shrink-0"
                  >
                    {ROLE_LABEL[m.role] ?? m.role}
                  </span>
                  {m.role !== 'owner' && (
                    <button
                      onClick={() => remove(m.user_email)}
                      style={{ color: 'var(--text-faint)' }}
                      className="text-xs shrink-0 hover:opacity-70"
                      onMouseEnter={e => e.currentTarget.style.color = 'var(--error)'}
                      onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
                      title="Remove"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Calendar feed */}
          <div>
            <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide mb-2">Calendar feed</p>
            <p style={{ color: 'var(--text-muted)' }} className="text-xs mb-2">
              Subscribe in Google/Apple Calendar to see this trip's itinerary — no login needed for whoever has the link.
            </p>
            <button
              onClick={copyCalendarUrl}
              disabled={calBusy}
              style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
              className="text-xs px-3 py-2 rounded-lg disabled:opacity-50 hover:opacity-80 transition-opacity"
            >
              {calBusy ? 'Working…' : calCopied ? 'Copied' : 'Copy calendar link'}
            </button>
            {calError && <p style={{ color: 'var(--error)' }} className="text-xs mt-1.5">{calError}</p>}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border)' }} className="flex justify-end px-5 py-4">
          <button
            onClick={onClose}
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
