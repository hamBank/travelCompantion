import { useOfflineQueue } from '../offlineQueue.js'

// The "n changes waiting to sync" line, plus a dismissible list of parked
// conflicts (same-field concurrent edits) with the plan 11 two-button
// resolution: server wins by default, "Apply mine" explicitly overrides it.
//
// `onLogout` is the same sign-out handler the header button uses (App.jsx) —
// re-used here as "Sign in" for the auth-expired case: it clears the stored
// token and drops back to LoginPage, and logging back in remounts this
// banner, which flushes the queue again with a fresh token.
export default function OfflineQueueBanner({ onLogout }) {
  const { count, conflicts, authExpired, resolve } = useOfflineQueue()
  if (!count && conflicts.length === 0) return null

  return (
    <div className="w-full px-4 sm:px-6 py-1.5 text-xs" style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }}>
      {count > 0 && authExpired && (
        <p style={{ color: 'var(--warning)' }} className="flex items-center gap-2 flex-wrap">
          <span>🔒 Sign in again to sync {count} change{count > 1 ? 's' : ''}</span>
          {onLogout && (
            <button
              onClick={onLogout}
              style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
              className="px-1.5 py-0.5 rounded hover:opacity-80"
            >
              Sign in
            </button>
          )}
        </p>
      )}
      {count > 0 && !authExpired && (
        <p style={{ color: 'var(--text-faint)' }}>
          ⏳ {count} change{count > 1 ? 's' : ''} waiting to sync
        </p>
      )}
      {conflicts.length > 0 && (
        <div className="mt-1 space-y-1">
          <p style={{ color: 'var(--warning)' }} className="font-medium">
            {conflicts.length} change{conflicts.length > 1 ? 's' : ''} couldn't sync
          </p>
          <ul className="space-y-1">
            {conflicts.map(c => (
              <ConflictRow key={c.id} conflict={c} onResolve={resolve} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ConflictRow({ conflict, onResolve }) {
  const fields = conflict.conflictBody?.conflicts || []
  return (
    <li style={{ color: 'var(--text-muted)' }} className="flex flex-wrap items-center gap-2">
      <span>
        {conflict.entity} #{conflict.entityId}
        {fields.map(f => ` · ${f.field}: yours "${f.mine}" vs. theirs "${f.server}"`).join('')}
      </span>
      <button
        onClick={() => onResolve(conflict.id, 'theirs')}
        style={{ color: 'var(--text-faint)', border: '1px solid var(--border)' }}
        className="px-1.5 py-0.5 rounded hover:opacity-80"
      >
        Keep theirs
      </button>
      <button
        onClick={() => onResolve(conflict.id, 'mine')}
        style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
        className="px-1.5 py-0.5 rounded hover:opacity-80"
      >
        Apply mine
      </button>
    </li>
  )
}
