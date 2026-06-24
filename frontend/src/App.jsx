import { useState, useEffect } from 'react'
import { GoogleOAuthProvider } from '@react-oauth/google'
import TripList from './components/TripList.jsx'
import TripTimeline from './components/TripTimeline.jsx'
import EditTrip from './components/EditTrip.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import LoginPage from './components/LoginPage.jsx'
import UserSettings from './components/UserSettings.jsx'
import ShareModal from './components/ShareModal.jsx'
import { DEFAULT_THEME } from './themes.js'
import { getAuthConfig, exportTripPdf } from './api.js'
import { canEdit, canManage } from './roles.js'

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  return online
}

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
  const online = useOnline()

  async function handleExportPdf() {
    if (!selectedTrip || exporting) return
    setExporting(true)
    try { await exportTripPdf(selectedTrip.id, selectedTrip.name) }
    catch (e) { alert(e.message) }
    finally { setExporting(false) }
  }

  const [userChoseList, setUserChoseList] = useState(false)

  function openTrip(trip) { setSelectedTrip(trip); setEditing(false); setStats(null) }
  function goBack() { setSelectedTrip(null); setEditing(false); setStats(null); setUserChoseList(true) }

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
        className="px-4 py-1.5 flex items-center gap-2 sticky top-0 z-20"
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

      <main className="max-w-2xl mx-auto px-4 py-6">
        {selectedTrip
          ? editing
            ? <EditTrip
                trip={selectedTrip}
                onTripRenamed={name => setSelectedTrip(t => ({ ...t, name }))}
              />
            : <TripTimeline tripId={selectedTrip.id} onStats={setStats} />
          : <TripList onOpen={openTrip} skipAutoOpen={userChoseList} />
        }
      </main>

      <footer className="max-w-2xl mx-auto px-4 pb-8 pt-4 flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap justify-center">
          {selectedTrip && online && canEdit(selectedTrip.role) && (
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
