import { useState, useEffect, useRef } from 'react'
import { GoogleOAuthProvider } from '@react-oauth/google'
import TripList from './components/TripList.jsx'
import TripTimeline from './components/TripTimeline.jsx'
import EditTrip from './components/EditTrip.jsx'
import ThemePicker from './components/ThemePicker.jsx'
import LoginPage from './components/LoginPage.jsx'
import UserSettings from './components/UserSettings.jsx'
import ShareModal from './components/ShareModal.jsx'
import SharedTripView from './components/SharedTripView.jsx'
import PendingReview from './components/PendingReview.jsx'
import PackingList from './components/PackingList.jsx'
import OfflineQueueBanner from './components/OfflineQueueBanner.jsx'
import BudgetSummary from './components/BudgetSummary.jsx'
import DocumentsModal from './components/DocumentsModal.jsx'
import MenuDropdown from './components/MenuDropdown.jsx'
import { DEFAULT_THEME } from './themes.js'
import { getAuthConfig, exportTripPdf, getPending, refreshAuthToken, AUTH_EXPIRED_EVENT } from './api.js'
import { Menu, Backpack, Wallet, Inbox, FileText, Settings, CalendarDays, Plane } from 'lucide-react'
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

function MenuItem({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ color: 'var(--text)' }}
      className="w-full text-left px-4 py-2.5 text-sm hover:opacity-80 transition-opacity disabled:opacity-50"
    >
      {children}
    </button>
  )
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
  const [hidePacked, setHidePacked] = useState(false)
  const [packing, setPacking] = useState(false)
  const [today, setToday] = useState(false)
  const [showBudget, setShowBudget] = useState(false)
  const [showDocuments, setShowDocuments] = useState(false)
  const [showImportDoc, setShowImportDoc] = useState(false)
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

  function openTrip(trip) { setSelectedTrip(trip); setEditing(false); setPacking(false); setToday(false); setStats(null); setTripStops([]); setKindFilter(''); setHidePacked(false) }
  function goBack() { setSelectedTrip(null); setEditing(false); setPacking(false); setToday(false); setStats(null); setUserChoseList(true); setTripStops([]); setKindFilter(''); setHidePacked(false) }

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
      <OfflineQueueBanner onLogout={onLogout} />

      <header
        className="px-3 sm:px-6 flex items-center gap-2 sticky top-0 z-20"
        style={{
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border)',
          // Standalone-PWA iOS draws the page under the status bar / camera
          // cutout (viewport-fit=cover + black-translucent in index.html) --
          // env(safe-area-inset-top) clears that. No cushion beyond the
          // inset itself (real-world feedback, three rounds: "too much
          // space" -> 0.2rem -> "could still move higher" -> 0.05rem ->
          // confirmed-deployed but still no visible movement -- a 2.4px
          // trim genuinely isn't perceptible, so this goes to the true
          // floor rather than shaving fractions of a px again).
          // Inline, not index.css: Tailwind utility classes are class
          // selectors and always beat an index.css element-selector rule —
          // see the note by the `main` safe-area rule there.
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: '0.1rem',
        }}
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
            <Plane size={16} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Travel Companion
          </h1>
        )}

        <div className="flex-1" />

        {user && (
          <MenuDropdown
            trigger={
              user.picture
                ? <img src={user.picture} alt={user.name} className="w-6 h-6 rounded-full" />
                : <span style={{ color: 'var(--text-faint)' }} aria-label="Menu"><Menu size={20} aria-hidden="true" /></span>
            }
          >
            {selectedTrip && online && !packing && !today && canEdit(selectedTrip.role) && (
              <MenuItem onClick={() => setEditing(e => !e)}>
                {editing ? 'View' : 'Edit'}
              </MenuItem>
            )}
            {selectedTrip && (
              <MenuItem onClick={() => { setPacking(p => !p); setEditing(false); setToday(false) }}>
                <Backpack size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />{packing ? 'Timeline' : 'Packing'}
              </MenuItem>
            )}
            {selectedTrip && online && canManage(selectedTrip.role) && (
              <MenuItem onClick={() => setShowShare(true)}>Share</MenuItem>
            )}
            {selectedTrip && online && (
              <MenuItem onClick={handleExportPdf} disabled={exporting}>
                {exporting ? 'Exporting…' : 'Export PDF'}
              </MenuItem>
            )}
            {selectedTrip && online && !packing && (
              <MenuItem onClick={() => setShowBudget(true)}><Wallet size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Budget</MenuItem>
            )}
            {online && pendingCount > 0 && (
              <MenuItem onClick={() => setShowImports(true)}>
                <span style={{ color: 'var(--warning)' }}><Inbox size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Imports ({pendingCount})</span>
              </MenuItem>
            )}
            <MenuItem onClick={() => setShowDocuments(true)}><FileText size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Documents</MenuItem>
            <MenuItem onClick={() => setShowSettings(true)}><Settings size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />Settings</MenuItem>
            <div className="px-4 py-2 flex flex-col gap-1.5 items-start">
              <span style={{ color: 'var(--text-muted)' }} className="text-sm">Theme</span>
              <ThemePicker current={theme} onChange={setTheme} />
            </div>
            <div style={{ borderTop: '1px solid var(--border)' }} className="mt-1 pt-1">
              <MenuItem onClick={onLogout}>
                <span title={user.email}>Sign out</span>
              </MenuItem>
            </div>
          </MenuDropdown>
        )}
      </header>

      {showSettings && <UserSettings onClose={() => setShowSettings(false)} />}
      {showDocuments && <DocumentsModal onClose={() => setShowDocuments(false)} />}
      {showShare && selectedTrip && <ShareModal trip={selectedTrip} onClose={() => setShowShare(false)} />}

      {showBudget && selectedTrip && (
        <BudgetSummary
          trip={selectedTrip} stops={tripStops}
          canEdit={online && canEdit(selectedTrip.role)}
          onClose={() => setShowBudget(false)}
        />
      )}
      {showImports && (
        <PendingReview
          onClose={() => { setShowImports(false); refreshPending() }}
          onChanged={refreshPending}
        />
      )}

      <KindFilterContext.Provider value={kindFilter}>
      <main className="w-full px-4 sm:px-8 lg:px-16 pt-1.5 pb-6">
        {selectedTrip
          ? packing
            ? <PackingList
              tripId={selectedTrip.id} userEmail={user?.email}
              canEdit={online && canEdit(selectedTrip.role)}
              canQueueEdit={!online && canEdit(selectedTrip.role)}
              hidePacked={hidePacked}
            />
            : editing
              ? <EditTrip
                  trip={selectedTrip}
                  onTripRenamed={name => setSelectedTrip(t => ({ ...t, name }))}
                  onTripUpdated={fields => setSelectedTrip(t => ({ ...t, ...fields }))}
                />
              : <TripTimeline
                  tripId={selectedTrip.id} onStats={setStats} onStops={setTripStops}
                  todayMode={today}
                  onExitToday={() => setToday(false)}
                  importing={showImportDoc} setImporting={setShowImportDoc}
                />
          : <TripList onOpen={openTrip} skipAutoOpen={userChoseList} />
        }
      </main>
      </KindFilterContext.Provider>

      <footer className="w-full px-4 sm:px-8 lg:px-16 pb-8 pt-4 flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap justify-center">
          {selectedTrip && online && !packing && (
            <button
              onClick={() => { setToday(t => !t); setEditing(false) }}
              style={{
                background: today ? 'var(--accent)' : 'transparent',
                color: today ? 'var(--accent-fg)' : 'var(--text-muted)',
                border: '1px solid',
                borderColor: today ? 'var(--accent)' : 'var(--border)',
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              <CalendarDays size={14} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em', marginRight: '0.35em' }} />{today ? 'All days' : 'Today'}
            </button>
          )}
          {selectedTrip && !editing && !packing && (
            <select
              value={kindFilter}
              onChange={e => setKindFilter(e.target.value)}
              aria-label="Filter by item kind"
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
          {selectedTrip && packing && (
            <select
              value={hidePacked ? 'hide' : 'all'}
              onChange={e => setHidePacked(e.target.value === 'hide')}
              aria-label="Show or hide packed items"
              title="Bags are always shown, even when their packed items are hidden"
              style={{
                background: hidePacked ? 'color-mix(in srgb, var(--accent) 12%, var(--surface))' : 'transparent',
                color: hidePacked ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${hidePacked ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border)'}`,
              }}
              className="px-2 py-1.5 rounded-lg text-xs font-medium outline-none cursor-pointer"
            >
              <option value="all" style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>All items</option>
              <option value="hide" style={{ background: 'var(--modal-bg)', color: 'var(--text)' }}>Hide packed</option>
            </select>
          )}
          {selectedTrip && !editing && !packing && online && canEdit(selectedTrip.role) && (
            <button
              onClick={() => setShowImportDoc(true)}
              style={{ color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)', background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              ⇪ Import from document
            </button>
          )}
          {selectedTrip && !editing && online && canEdit(selectedTrip.role) && tripStops.length > 0 && (
            <button
              onClick={() => setShowQuickAdd(true)}
              style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 transition-opacity"
            >
              + Add item
            </button>
          )}
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

// This app has no client-side router at all — everything below decides what
// to render purely from React state (selectedTrip, editing, etc.), never
// from location.pathname. The public share link is the one exception: it
// must be reachable by a bare URL with no login, so it's the one place this
// app looks at the path directly. Kept as a separate top-level dispatch
// (rather than an early-return inside AuthenticatedApp) specifically so it
// stays outside the hooks in AuthenticatedApp below — an early return
// before useState/useEffect would violate the rules of hooks. The path
// itself is only ever read once at mount: this SPA never client-side-
// navigates between a normal session and a shared one (a real browser
// navigation reloads the page), so there's no scenario where this needs to
// react to the pathname changing under a mounted instance.
const SHARED_PATH_RE = /^\/shared\/([^/]+)\/?$/

export default function App() {
  const sharedMatch = typeof window !== 'undefined' ? window.location.pathname.match(SHARED_PATH_RE) : null
  if (sharedMatch) {
    return <SharedTripView token={sharedMatch[1]} />
  }
  return <AuthenticatedApp />
}

function AuthenticatedApp() {
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

  // Expired/invalidated session (any authed request came back 401, see
  // api.js) — sign out so the login page shows, rather than leaving the app
  // up with every request failing until the user finds Sign out themselves.
  useEffect(() => {
    if (!authEnabled) return
    const onExpired = () => handleLogout()
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
  }, [authEnabled])

  // Sliding session: refresh the stored JWT on boot and daily while the app
  // stays open (a phone PWA can stay "open" for weeks without rebooting the
  // page), so an actively-used session never hits the fixed JWT_EXPIRE_DAYS
  // cliff — it only expires after that long of not using the app at all.
  // Failures are ignored: offline is fine (next interval/boot retries), and
  // an actually-dead token 401s → the expiry handler above signs out.
  useEffect(() => {
    if (!authEnabled || !user) return
    const doRefresh = () => { refreshAuthToken().catch(() => {}) }
    doRefresh()
    const id = setInterval(doRefresh, 24 * 60 * 60 * 1000)
    return () => clearInterval(id)
  }, [authEnabled, user])

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
