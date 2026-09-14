import { createContext } from 'react'

// TripTimeline's seam onto the shell's own navigation state (plan-18b): the
// current App.jsx snapshotFromState(...) with day/item always null
// (TripTimeline fills those in itself — see openItem/handleModalNav/
// navigateDay there). Kept in its own module rather than exported straight
// from App.jsx so TripTimeline.jsx (and its tests) don't have to pull in
// App.jsx's whole import graph — and the App.jsx <-> TripTimeline.jsx module
// cycle that would create — just to reach this. App.jsx still owns
// *providing* it (AppShell wraps TripTimeline in
// <NavBaseContext.Provider value={snapshotFromState(...)}>) and re-exports
// it for convenience.
export const NavBaseContext = createContext(null)
