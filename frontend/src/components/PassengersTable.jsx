/**
 * PassengersTable — renders a passengers or participants detail field.
 *
 * New format: array of objects  [{name, ticket, loyalty, ff_tier, seat, meal, baggage}, …]
 * Legacy format: plain string   (rendered as-is, no structure)
 */

const PASSENGER_DETAIL_FIELDS = [
  { key: 'ticket',  label: 'Ticket'  },
  { key: 'loyalty', label: 'Loyalty' },
  { key: 'ff_tier', label: 'Tier'    },
  { key: 'seat',    label: 'Seat'    },
  { key: 'meal',    label: 'Meal'    },
  { key: 'baggage', label: 'Baggage' },
]

function PassengerRow({ p, border }) {
  const details = PASSENGER_DETAIL_FIELDS.filter(f => p[f.key])
  return (
    <div
      className="py-2"
      style={border ? { borderTop: '1px solid var(--border)' } : undefined}
    >
      {p.name && (
        <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>{p.name}</div>
      )}
      {details.length > 0 && (
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>
          {details.map(f => (
            <span key={f.key} className="mr-3">
              <span className="uppercase tracking-wide" style={{ fontSize: '0.65rem' }}>{f.label}</span>
              {' '}
              <span style={{ color: 'var(--text)' }}>{p[f.key]}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PassengersTable({ passengers, label = 'Passengers' }) {
  if (!passengers) return null

  // Legacy string — display as plain Row
  if (typeof passengers === 'string') {
    if (!passengers.trim()) return null
    return (
      <div className="flex gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
        <span
          style={{ color: 'var(--text-faint)', minWidth: '8rem' }}
          className="text-xs uppercase tracking-wide shrink-0 pt-0.5"
        >
          {label}
        </span>
        <span style={{ color: 'var(--text)' }} className="text-sm break-words min-w-0 flex-1">
          {passengers}
        </span>
      </div>
    )
  }

  if (!Array.isArray(passengers) || passengers.length === 0) return null

  return (
    <div className="py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
      <span
        style={{ color: 'var(--text-faint)' }}
        className="text-xs uppercase tracking-wide"
      >
        {label}
      </span>
      <div>
        {passengers.map((p, i) => (
          <PassengerRow key={i} p={p} border={i > 0} />
        ))}
      </div>
    </div>
  )
}
