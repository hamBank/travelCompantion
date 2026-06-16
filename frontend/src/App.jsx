import { useState } from 'react'
import TripList from './components/TripList.jsx'
import TripTimeline from './components/TripTimeline.jsx'
import EditTrip from './components/EditTrip.jsx'

export default function App() {
  const [selectedTrip, setSelectedTrip] = useState(null)
  const [editing, setEditing] = useState(false)

  function openTrip(trip) {
    setSelectedTrip(trip)
    setEditing(false)
  }

  function goBack() {
    setSelectedTrip(null)
    setEditing(false)
  }

  if (selectedTrip) {
    return (
      <div className="min-h-screen" style={{ background: '#1e1e2e', color: '#cdd6f4' }}>
        <header style={{ borderBottom: '1px solid #313244' }} className="px-6 py-4 flex items-center gap-4">
          <button
            onClick={goBack}
            style={{ color: '#6c7086' }}
            className="text-sm hover:opacity-70 transition-opacity"
          >
            ← Trips
          </button>
          <h1 style={{ color: '#cba6f7' }} className="font-semibold text-lg flex-1">
            {selectedTrip.name}
          </h1>
          <button
            onClick={() => setEditing(e => !e)}
            style={{
              background: editing ? '#cba6f7' : 'transparent',
              color: editing ? '#1e1e2e' : '#9399b2',
              border: '1px solid',
              borderColor: editing ? '#cba6f7' : '#313244',
            }}
            className="px-3 py-1 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
          >
            {editing ? 'View' : 'Edit'}
          </button>
        </header>
        <main className="max-w-2xl mx-auto px-4 py-6">
          {editing
            ? <EditTrip
                trip={selectedTrip}
                onTripRenamed={name => setSelectedTrip(t => ({ ...t, name }))}
              />
            : <TripTimeline tripId={selectedTrip.id} />
          }
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#1e1e2e', color: '#cdd6f4' }}>
      <header style={{ borderBottom: '1px solid #313244' }} className="px-6 py-4">
        <h1 style={{ color: '#cba6f7' }} className="font-semibold text-lg">✈ Travel Companion</h1>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-6">
        <TripList onOpen={openTrip} />
      </main>
    </div>
  )
}
