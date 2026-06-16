import { useState } from 'react'
import TripList from './components/TripList.jsx'
import TripTimeline from './components/TripTimeline.jsx'

export default function App() {
  const [selectedTrip, setSelectedTrip] = useState(null)

  if (selectedTrip) {
    return (
      <div className="min-h-screen" style={{ background: '#1e1e2e', color: '#cdd6f4' }}>
        <header style={{ borderBottom: '1px solid #313244' }} className="px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => setSelectedTrip(null)}
            style={{ color: '#6c7086' }}
            className="text-sm hover:opacity-70 transition-opacity"
          >
            ← Trips
          </button>
          <h1 style={{ color: '#cba6f7' }} className="font-semibold text-lg">{selectedTrip.name}</h1>
        </header>
        <main className="max-w-2xl mx-auto px-4 py-6">
          <TripTimeline tripId={selectedTrip.id} />
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
        <TripList onOpen={setSelectedTrip} />
      </main>
    </div>
  )
}
