import { Component, Suspense, lazy } from 'react'

// Code-split a component, and survive a deploy that happens while the app is open.
//
// A build replaces the hashed chunk files. A page loaded before the deploy still
// asks for the old names, which no longer exist, so the dynamic import fails (the
// server may even answer with the SPA's index.html, which fails to parse as JS).
// The stale-client poller reloads open tabs when the frontend changes, but it runs
// on a timer and can lose the race with someone tapping a button. On a failed
// chunk load we reload once, which fetches the new index.html and its chunk names.
//
// The flag stops a reload loop if the chunk is missing for a real reason: the
// second failure inside the window rethrows to the nearest error boundary instead.
const RELOAD_KEY = 'tc-chunk-reload-at'
const RELOAD_WINDOW_MS = 60_000

export function reloadOnceForStaleChunk(now = Date.now()) {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (now - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(now))
  } catch {
    return false // no sessionStorage: can't guard against a loop, so don't reload
  }
  window.location.reload()
  return true
}

export function lazyWithReload(factory) {
  return lazy(() =>
    factory().catch(err => {
      if (reloadOnceForStaleChunk()) {
        // Keep Suspense's fallback up while the page reloads.
        return new Promise(() => {})
      }
      throw err
    }),
  )
}

// If a view's chunk cannot be loaded at all (offline with the chunk not cached, or
// a second failure right after the reload above), degrade to a message instead of
// letting the error unmount the whole app.
class ChunkErrorBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err) { console.error('Could not load this view:', err) }
  render() {
    if (!this.state.failed) return this.props.children
    const { onClose } = this.props
    return (
      <div
        role="alert"
        style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 60, padding: '0.75rem 1rem',
          background: 'var(--surface, #fff)', color: 'var(--text, #111)',
          borderTop: '1px solid var(--border, #ccc)', textAlign: 'center', fontSize: '0.875rem',
        }}
      >
        Couldn&apos;t load this view. Check your connection and try again.
        {onClose && (
          <button type="button" onClick={onClose} style={{ marginLeft: '0.75rem', textDecoration: 'underline' }}>
            Close
          </button>
        )}
      </div>
    )
  }
}

// A lazily loaded component that brings its own Suspense boundary and error
// boundary, so it can be dropped in wherever the eager import used to be. The
// boundaries are local on purpose: a suspended component inside a *visible*
// boundary hides everything the boundary already shows, so one app-wide boundary
// would blank the page whenever a modal's chunk loaded. fallback={null}: a modal
// simply appears once ready.
export function lazyComponent(factory, fallback = null) {
  const Lazy = lazyWithReload(factory)
  return function LazyComponent(props) {
    return (
      <ChunkErrorBoundary onClose={props.onClose}>
        <Suspense fallback={fallback}>
          <Lazy {...props} />
        </Suspense>
      </ChunkErrorBoundary>
    )
  }
}
