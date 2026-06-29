import { describe, it, expect, beforeEach } from 'vitest'
import { setEditing, isEditing, onEditChange } from '../editState.js'

beforeEach(() => setEditing(false))

describe('editState', () => {
  it('starts as not editing', () => expect(isEditing()).toBe(false))
  it('can be set to true', () => { setEditing(true); expect(isEditing()).toBe(true) })
  it('can be cleared', () => { setEditing(true); setEditing(false); expect(isEditing()).toBe(false) })

  it('notifies listeners on change', () => {
    const calls = []
    const unsub = onEditChange(v => calls.push(v))
    setEditing(true)
    setEditing(false)
    unsub()
    setEditing(true)   // after unsub — should not appear
    expect(calls).toEqual([true, false])
  })
})
