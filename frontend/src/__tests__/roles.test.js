import { describe, it, expect } from 'vitest'
import { canEdit, canManage } from '../roles.js'

describe('canEdit', () => {
  it('allows editor and owner, denies viewer', () => {
    expect(canEdit('owner')).toBe(true)
    expect(canEdit('editor')).toBe(true)
    expect(canEdit('viewer')).toBe(false)
  })
  it('defaults to editable when role is unknown (auth-disabled / dev)', () => {
    expect(canEdit(undefined)).toBe(true)
  })
})

describe('canManage', () => {
  it('is owner-only', () => {
    expect(canManage('owner')).toBe(true)
    expect(canManage('editor')).toBe(false)
    expect(canManage('viewer')).toBe(false)
  })
})
