import { useEffect, useState } from 'react'
import { Users } from 'lucide-react'
import { getTravelers } from '../api.js'

// One line under the header saying who is going on this trip, so the answer is
// visible without opening the Travelers screen from the menu. An empty list is
// flagged, since reminders and totals can only guess from trip membership then.
// `refreshKey` changes whenever the Travelers screen opens/closes, to refetch.
export default function TravelersBar({ tripId, onOpen, refreshKey }) {
  const [travelers, setTravelers] = useState(null)

  useEffect(() => {
    if (!tripId) return
    let cancelled = false
    setTravelers(null)
    getTravelers(tripId)
      .then(t => { if (!cancelled) setTravelers(t) })
      .catch(() => { if (!cancelled) setTravelers(null) })
    return () => { cancelled = true }
  }, [tripId, refreshKey])

  if (travelers === null) return null

  const names = travelers.map(t => t.display_name)
  const shown = names.slice(0, 3).join(', ')
  const extra = names.length > 3 ? ` +${names.length - 3}` : ''

  return (
    <button
      onClick={onOpen}
      style={{ color: 'var(--text-faint)', borderBottom: '1px solid var(--border)' }}
      className="w-full text-left text-xs px-4 sm:px-8 lg:px-16 py-1.5 flex items-center gap-1.5 hover:opacity-80"
    >
      <Users size={13} aria-hidden="true" />
      {names.length
        ? <span><span style={{ color: 'var(--text)' }}>{shown}{extra}</span> travelling</span>
        : <span style={{ color: 'var(--warning)' }}>No travelers added yet — tap to say who's going</span>}
    </button>
  )
}
