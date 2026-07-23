import { describe, it, expect, beforeEach } from 'vitest'
import {
  getHideCompleted, setHideCompleted,
  getShowInbound, setShowInbound,
  getDefaultToToday, setDefaultToToday,
} from '../settings.js'

beforeEach(() => localStorage.clear())

describe('hide-completed preference', () => {
  it('defaults to false and toggles', () => {
    expect(getHideCompleted()).toBe(false)
    setHideCompleted(true)
    expect(getHideCompleted()).toBe(true)
    setHideCompleted(false)
    expect(getHideCompleted()).toBe(false)
  })
})

describe('show-inbound preference', () => {
  it('defaults to true and only "0" disables it', () => {
    expect(getShowInbound()).toBe(true)
    setShowInbound(false)
    expect(getShowInbound()).toBe(false)
    setShowInbound(true)
    expect(getShowInbound()).toBe(true)
  })
})

describe('default-to-today preference', () => {
  it('defaults to false and toggles', () => {
    expect(getDefaultToToday()).toBe(false)
    setDefaultToToday(true)
    expect(getDefaultToToday()).toBe(true)
    setDefaultToToday(false)
    expect(getDefaultToToday()).toBe(false)
  })
})
