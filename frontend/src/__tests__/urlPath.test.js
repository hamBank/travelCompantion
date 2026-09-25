import { describe, it, expect } from 'vitest'
import { snapshotToPath, parseDeepLinkPath } from '../urlPath.js'

describe('snapshotToPath', () => {
  it('root/no-trip snapshot is /', () => {
    expect(snapshotToPath({ tripId: null })).toBe('/')
    expect(snapshotToPath(null)).toBe('/')
  })

  it('a bare trip snapshot is /t/:id', () => {
    expect(snapshotToPath({ tripId: 42, mode: 'timeline', day: null, item: null })).toBe('/t/42')
  })

  it('Today mode with a day is /t/:id/day/:day', () => {
    expect(snapshotToPath({ tripId: 42, mode: 'today', day: '2026-09-16', item: null })).toBe('/t/42/day/2026-09-16')
  })

  it('a today snapshot with no day yet falls back to the bare trip link', () => {
    expect(snapshotToPath({ tripId: 42, mode: 'today', day: null, item: null })).toBe('/t/42')
  })

  it('an open item wins over the day/mode', () => {
    expect(snapshotToPath({ tripId: 42, mode: 'today', day: '2026-09-16', item: { id: 7, edit: false } }))
      .toBe('/t/42/item/7')
    expect(snapshotToPath({ tripId: 42, mode: 'timeline', day: null, item: { id: 7, edit: true } }))
      .toBe('/t/42/item/7')
  })

  it('other modes (calendar/edit/packing) and overlays fall back to the bare trip link', () => {
    expect(snapshotToPath({ tripId: 42, mode: 'calendar', day: null, item: null })).toBe('/t/42')
    expect(snapshotToPath({ tripId: 42, mode: 'edit', day: null, item: null })).toBe('/t/42')
    expect(snapshotToPath({ tripId: 42, mode: 'packing', day: null, item: null })).toBe('/t/42')
  })
})

describe('parseDeepLinkPath', () => {
  it('parses a bare trip link', () => {
    expect(parseDeepLinkPath('/t/42')).toEqual({ tripId: 42, kind: null, value: null })
    expect(parseDeepLinkPath('/t/42/')).toEqual({ tripId: 42, kind: null, value: null })
  })

  it('parses a day link', () => {
    expect(parseDeepLinkPath('/t/42/day/2026-09-16')).toEqual({ tripId: 42, kind: 'day', value: '2026-09-16' })
  })

  it('parses an item link', () => {
    expect(parseDeepLinkPath('/t/42/item/7')).toEqual({ tripId: 42, kind: 'item', value: '7' })
  })

  it('parses a stop link', () => {
    expect(parseDeepLinkPath('/t/42/stop/9')).toEqual({ tripId: 42, kind: 'stop', value: '9' })
  })

  it('returns null for the root, a foreign path, or an unknown kind', () => {
    expect(parseDeepLinkPath('/')).toBeNull()
    expect(parseDeepLinkPath('/shared/abc123')).toBeNull()
    expect(parseDeepLinkPath('/t/42/edit/whatever')).toBeNull()
  })

  it('returns null for a non-numeric trip id', () => {
    expect(parseDeepLinkPath('/t/abc')).toBeNull()
  })

  it('handles an empty/undefined pathname', () => {
    expect(parseDeepLinkPath('')).toBeNull()
    expect(parseDeepLinkPath(undefined)).toBeNull()
  })
})
