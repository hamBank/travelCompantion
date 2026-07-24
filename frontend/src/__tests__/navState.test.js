import { describe, it, expect, beforeEach } from 'vitest'
import { getSavedNav, saveNav, clearNav } from '../navState.js'

beforeEach(() => localStorage.clear())

describe('navState', () => {
  it('returns null when nothing has been saved', () => {
    expect(getSavedNav()).toBeNull()
  })

  it('round-trips a saved trip/today snapshot', () => {
    saveNav({ tripId: 42, today: true })
    expect(getSavedNav()).toEqual({ tripId: 42, today: true })
  })

  it('clears the saved snapshot', () => {
    saveNav({ tripId: 42, today: false })
    clearNav()
    expect(getSavedNav()).toBeNull()
  })

  it('treats a missing tripId as nothing saved', () => {
    localStorage.setItem('tc-last-nav', JSON.stringify({ today: true }))
    expect(getSavedNav()).toBeNull()
  })

  it('treats corrupted JSON as nothing saved', () => {
    localStorage.setItem('tc-last-nav', '{not json')
    expect(getSavedNav()).toBeNull()
  })
})
