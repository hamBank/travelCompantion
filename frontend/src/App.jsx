import { useState, useEffect, useRef } from 'react'
import { GoogleOAuthProvider } from '@react-oauth/google'
import TripList from './components/TripList.jsx'
import TripTimeline from './components/TripTimeline.jsx'
import EditTrip from './components/EditTrip.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import LoginPage from './components/LoginPage.jsx'
import UserSettings from './components/UserSettings.jsx'
import ShareModal from './components/ShareModal.jsx'
import PendingReview from './components/PendingReview.jsx'
import PackingList from './components/PackingList.jsx'
import { DEFAULT_THEME } from './themes.js'
import { getAuthConfig, exportTripPdf, getPending } from './api.js'
import { canEdit, canManage } from './roles.js'
import { applyFontScale, KindFilterContext } from './settings.js'
import { KIND_OPTIONS, KIND_LABEL } from './kinds.js'
import { useOnline } from './online.js'
import ItemEditModal from './components/ItemEditModal.jsx'

// Apply saved font scale before first render
applyFontScale()

function useTheme() {
  const [theme, setThemeState] = useState(
    () => localStorage.getItem('tc-theme') || DEFAULT_THEME
  )
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('tc-theme', theme)
  }, [theme])
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
  return [theme, setThemeState]
}

function AppShell({ user, onLogout }) {
  const [selectedTrip, setSelectedTrip] = useState(null)
  const [editing, setEditing] = useState(false)
  const [theme, setTheme] = useTheme()
  const [showSettings, setShowSettings] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [stats, setStats] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [showImports, setShowImports] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [tripStops, setTripStops] = useState([])
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [kindFilter, setKindFilter] = useState('')
  const [packing, setPacking] = useState(false)
  const online = useOnline()

  function refreshPending() {
    if (online) getPending().then(p => setPendingCount(p.length)).catch(() => {})
  }
  useEffect(() => { refreshPending() }, [online])

  // Poll for new pending imports every 60 s so email arrivals surface without a reload.
  const pendingTimerRef = useRef(null)
  useEffect(() => {
    if (!online) return
    pendingTimerRef.current = setInterval(refreshPending, 60_000)
    return () => clearInterval(pendingTimerRef.current)
  }, [online])

  async function handleExportPdf() {
    if (!selectedTrip || exporting) return
    setExporting(true)
    try { await exportTripPdf(selectedTrip.id, selectedTrip.name) }
    catch (e) { alert(e.message) }
    finally { setExporting(false) }
  }

  const [userChoseList, setUserChoseList] = useState(false)

  function openTrip(trip) { setSelectedTrip(trip); setEditing(false); setPacking(false); setStats(null); setTripStops([]); setKindFilter('') }
  function goBack() { setSelectedTrip(null); setEditing(false); setPacking(false); setStats(null); setUserChoseList(true); setTripStops([]); setKindFilter('') }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {!online && (
        <div
          className="w-full text-center text-xs py-1.5 px-4"
          style={{ background: 'var(--warning)', color: '#1e1e2e', fontWeight: 500 }}
        >
          Offline — read-only
        </div>
      )}

      <header
        className="px-3 sm:px-6 py-1.5 flex items-center gap-2 sticky top-0 z-20"
        style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}
      >
        {selectedTrip ? (
          <>
            <button
              onClick={goBack}
              style={{ color: 'var(--text-faint)' }}
              className="text-xs hover:opacity-70 transition-opacity shrink-0"
            >
              ←
            </button>
            <h1 style={{ color: 'var(--accent)' }} className="font-semibold text-xs truncate shrink min-w-0">
              {selectedTrip.name}
            </h1>
            {!editing && stats && (
              <span style={{ color: 'var(--text-faint)' }} className="text-xs shrink-0 whitespace-nowrap">
                {stats.total} stops · {stats.completed} completed
              </span>
            )}
          </>
        ) : (
          <h1 style={{ color: 'var(--accent)' }} className="font-semibold text-sm">
            ✈ Travel Companion
          </h1>
        )}

        <div className="flex-1" />

        {user && (
          <button
            onClick={onLogout}
            title={user.email}
            className="shrink-0 hover:opacity-70 transition-opacity"
          >
            {user.picture
              ? <img src={user.picture} alt={user.name} className="w-6 h-6 rounded-full" />
              : <span style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}>Sign out</span>
            }
          </button>
        )}
      </header>

      {showSettings && <UserSettings onClose={() => setShowSettings(false)} />}
      {showShare && selectedTrip && <ShareModal trip={selectedTrip} onClose={() => setShowShare(false)} />}
      {showImports && (
        <PendingReview
          onClose={() => { setShowImports(false); refreshPending() }}
          onChanged={refreshPending}
        />
      )}

      <KindFilterContext.Provider value={kindFilter}>
      <main className="w-full px-4 sm:px-8 lg:px-16 py-6">
        {selectedTrip
          ? packing
            ? <PackingList tripId={selectedTrip.id} userEmail={user?.email} canEdit={canEdit(selectedTrip.role)} />
            : editing
              ? <EditTrip
                  trip={selectedTrip}
                  onTripRenamed={name => setSelectedTrip(t => ({ ...t, name }))}
                />
              : <TripTimeline tripId={selectedTrip.id} onStats={setStats} onStops={setTripStops} />
          : <TripList onOpen={openTrip} skipAutoOpen={userChoseList} />
        }
      </main>
      </KindFilterContext.Provider>

      <footer className="w-full px-4 sm:px-8 lg:px-16 pb-8 pt-4 flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap justify-center">
          {selectedTrip && !editing && online && canEdit(selectedTrip.role) && tripStops.length > 0 && (
            <button
              onClick={() => setShowQuickAdd(true)}
              style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              + Add item
            </button>
          )}
          {selectedTrip && online && !packing && canEdit(selectedTrip.role) && (
            <button
              onClick={() => setEditing(e => !e)}
              style={{
                background: editing ? 'var(--accent)' : 'transparent',
                color: editing ? 'var(--accent-fg)' : 'var(--text-muted)',
                border: '1px solid',
                borderColor: editing ? 'var(--accent)' : 'var(--border)',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              {editing ? 'View' : 'Edit'}
            </button>
          )}
          {selectedTrip && online && (
            <button
              onClick={() => { setPacking(p => !p); setEditing(false) }}
              style={{
                background: packing ? 'var(--accent)' : 'transparent',
                color: packing ? 'var(--accent-fg)' : 'var(--text-muted)',
                border: '1px solid',
                borderColor: packing ? 'var(--accent)' : 'var(--border)',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              🎒 {packing ? 'Timeline' : 'Packing'}
            </button>
          )}
          {selectedTrip && online && canManage(selectedTrip.role) && (
            <button
              onClick={() => setShowShare(true)}
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              Share
            </button>
          )}
          {selectedTrip && online && (
            <button
              onClick={handleExportPdf}
              disabled={exporting}
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity disabled:opacity-50"
            >
              {exporting ? 'Exporting…' : 'Export PDF'}
            </button>
          )}
          {online && pendingCount > 0 && (
            <button
              onClick={() => setShowImports(true)}
              style={{ color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              📥 Imports ({pendingCount})
            </button>
          )}
          {selectedTrip && !editing && (
            <select
              value={kindFilter}
              onChange={e => setKindFilter(e.target.value)}
              style={{
                background: kindFilter ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'transparent',
                color: kindFilter ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${kindFilter ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)'}`,
              }}
              className="px-2 py-1.5 rounded-lg text-xs font-medium outline-none cursor-pointer"
            >
              <option value="">All items</option>
              {KIND_OPTIONS.map(k => (
                <option key={k} value={k} style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowSettings(true)}
            style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
          >
            ⚙ Settings
          </button>
          <ThemePicker current={theme} onChange={setTheme} />
        </div>
        <div className="flex gap-4 justify-center" style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}>
          <a href="/privacy.html" style={{ color: 'var(--text-faint)' }} className="hover:underline">
            Privacy Policy
          </a>
          <a href="/tos.html" style={{ color: 'var(--text-faint)' }} className="hover:underline">
            Terms of Service
          </a>
          <a href="/coverage/" style={{ color: 'var(--text-faint)' }} className="hover:underline">Coverage</a>
          <span title="Loaded client build">build {typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev'}</span>
        </div>
      </footer>

      {showQuickAdd && (
        <ItemEditModal
          item={{ stop_id: tripStops[0]?.id, kind: 'activity', name: '', status: 'pending', details: {} }}
          isNew
          stops={tripStops}
          onSave={() => setShowQuickAdd(false)}
          onClose={() => setShowQuickAdd(false)}
        />
      )}
    </div>
  )
}

export default function App() {
  const [authReady, setAuthReady] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [googleClientId, setGoogleClientId] = useState('')
  const [user, setUser] = useState(null)

  useEffect(() => {
    getAuthConfig()
      .then(cfg => {
        setAuthEnabled(cfg.enabled)
        setGoogleClientId(cfg.client_id)
        if (!cfg.enabled) {
          // No auth configured — go straight in
          setUser({ email: 'dev@local', name: 'Dev', picture: '' })
        } else {
          // Check for existing token
          const token = localStorage.getItem('tc-token')
          if (token) setUser({ fromToken: true })
        }
      })
      .catch(() => {
        // Backend unreachable — allow offline access if a token exists
        const token = localStorage.getItem('tc-token')
        if (token) setUser({ fromToken: true })
      })
      .finally(() => setAuthReady(true))
  }, [])

  function handleLogin(u) { setUser(u) }

  function handleLogout() {
    localStorage.removeItem('tc-token')
    setUser(null)
  }

  if (!authReady) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg)' }}
      />
    )
  }

  const shell = <AppShell user={user} onLogout={authEnabled ? handleLogout : null} />

  if (!authEnabled || user) {
    return googleClientId
      ? <GoogleOAuthProvider clientId={googleClientId}>{shell}</GoogleOAuthProvider>
      : shell
  }

  return (
    <GoogleOAuthProvider clientId={googleClientId}>
      <LoginPage onLogin={handleLogin} />
    </GoogleOAuthProvider>
  )
}
