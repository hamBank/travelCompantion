import { useState, useEffect } from 'react'
import TripList from './components/TripList.jsx'
import TripTimeline from './components/TripTimeline.jsx'
import EditTrip from './components/EditTrip.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import { DEFAULT_THEME } from './themes.js'

function useTheme() {
  const [theme, setThemeState] = useState(
    () => localStorage.getItem('tc-theme') || DEFAULT_THEME
  )
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('tc-theme', theme)
  }, [theme])
  // apply immediately on first render (before effect)
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
  return [theme, setThemeState]
}

export default function App() {
  const [selectedTrip, setSelectedTrip] = useState(null)
  const [editing, setEditing] = useState(false)
  const [theme, setTheme] = useTheme()

  function openTrip(trip) { setSelectedTrip(trip); setEditing(false) }
  function goBack() { setSelectedTrip(null); setEditing(false) }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header
        className="px-6 py-4 flex items-center gap-4 sticky top-0 z-20"
        style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}
      >
        {selectedTrip ? (
          <>
            <button
              onClick={goBack}
              style={{ color: 'var(--text-faint)' }}
              className="text-sm hover:opacity-70 transition-opacity shrink-0"
            >
              ← Trips
            </button>
            <h1
              style={{ color: 'var(--accent)' }}
              className="font-semibold text-lg flex-1 truncate"
            >
              {selectedTrip.name}
            </h1>
            <ThemePicker current={theme} onChange={setTheme} />
            <button
              onClick={() => setEditing(e => !e)}
              style={{
                background: editing ? 'var(--accent)' : 'transparent',
                color: editing ? 'var(--accent-fg)' : 'var(--text-muted)',
                border: '1px solid',
                borderColor: editing ? 'var(--accent)' : 'var(--border)',
              }}
              className="px-3 py-1 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity shrink-0"
            >
              {editing ? 'View' : 'Edit'}
            </button>
          </>
        ) : (
          <>
            <h1 style={{ color: 'var(--accent)' }} className="font-semibold text-lg flex-1">
              ✈ Travel Companion
            </h1>
            <ThemePicker current={theme} onChange={setTheme} />
          </>
        )}
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {selectedTrip
          ? editing
            ? <EditTrip
                trip={selectedTrip}
                onTripRenamed={name => setSelectedTrip(t => ({ ...t, name }))}
              />
            : <TripTimeline tripId={selectedTrip.id} />
          : <TripList onOpen={openTrip} />
        }
      </main>
    </div>
  )
}
