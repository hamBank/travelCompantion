import { describe, it, expect } from 'vitest'
import { canEdit, canManage, effectiveRole } from '../roles.js'

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

describe('effectiveRole', () => {
  it('passes the trip role through while online', () => {
    expect(effectiveRole('editor', true)).toBe('editor')
    expect(effectiveRole('viewer', true)).toBe('viewer')
    expect(effectiveRole('owner', true)).toBe('owner')
  })

  it('defaults a missing role to owner while online (matches RoleContext default)', () => {
    expect(effectiveRole(null, true)).toBe('owner')
    expect(effectiveRole(undefined, true)).toBe('owner')
  })

  it('forces viewer while offline, regardless of the real role', () => {
    expect(effectiveRole('owner', false)).toBe('viewer')
    expect(effectiveRole('editor', false)).toBe('viewer')
    expect(effectiveRole(null, false)).toBe('viewer')
  })

  it('offline viewer role hides edit and manage affordances', () => {
    const offline = effectiveRole('owner', false)
    expect(canEdit(offline)).toBe(false)
    expect(canManage(offline)).toBe(false)
  })
})
