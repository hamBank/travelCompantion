import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { lazyComponent, lazyWithReload, reloadOnceForStaleChunk } from '../lazyWithReload.jsx'

/**
 * Code-split modals must survive a deploy that happens while the app is open:
 * the chunk the old page asks for no longer exists, so the dynamic import fails.
 * The wrapper reloads once to pick up the new build, and never loops.
 */

let reload

beforeEach(() => {
  sessionStorage.clear()
  reload = vi.fn()
  Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('lazyComponent', () => {
  it('shows the fallback, then the component, passing props through', async () => {
    let release
    const Slow = lazyComponent(
      () => new Promise(res => { release = () => res({ default: ({ label }) => <p>loaded {label}</p> }) }),
      <p>loading…</p>,
    )
    render(<Slow label="ok" />)
    expect(screen.getByText('loading…')).toBeInTheDocument()
    release()
    expect(await screen.findByText('loaded ok')).toBeInTheDocument()
  })

  it('renders nothing while loading by default (a modal just appears when ready)', async () => {
    let release
    const Modal = lazyComponent(() => new Promise(res => { release = () => res({ default: () => <p>modal</p> }) }))
    const { container } = render(<Modal />)
    expect(container).toBeEmptyDOMElement()
    release()
    expect(await screen.findByText('modal')).toBeInTheDocument()
  })
})

describe('stale-chunk recovery', () => {
  it('reloads the page once when the chunk fails to load, keeping the fallback up', async () => {
    const Stale = lazyComponent(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')), <p>loading…</p>)
    render(<Stale />)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(screen.getByText('loading…')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not reload again inside the window: the view degrades to a message, the app stays up', async () => {
    sessionStorage.setItem('tc-chunk-reload-at', String(Date.now()))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onClose = vi.fn()
    const Stale = lazyComponent(() => Promise.reject(new TypeError('chunk gone')))
    render(<div><p>rest of the app</p><Stale onClose={onClose} /></div>)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this view")
    expect(screen.getByText('rest of the app')).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
    screen.getByRole('button', { name: 'Close' }).click()
    expect(onClose).toHaveBeenCalled()
  })

  it('reloads again once the window has passed', () => {
    sessionStorage.setItem('tc-chunk-reload-at', String(Date.now() - 61_000))
    expect(reloadOnceForStaleChunk()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload when sessionStorage is unavailable (it could not stop a loop)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(reloadOnceForStaleChunk()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('lazyWithReload (the bare form) recovers the same way', async () => {
    const Bare = lazyWithReload(() => Promise.reject(new Error('gone')))
    const { Suspense } = await import('react')
    render(<Suspense fallback={<p>wait</p>}><Bare /></Suspense>)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })
})
