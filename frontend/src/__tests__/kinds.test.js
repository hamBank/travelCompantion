import { describe, it, expect } from 'vitest'
import { KIND_VAR, KIND_LABEL, KIND_OPTIONS } from '../kinds.js'

describe('kinds registry', () => {
  it('has a label and colour var for every kind', () => {
    for (const k of Object.keys(KIND_VAR)) {
      expect(KIND_LABEL[k]).toBeTruthy()
      expect(KIND_VAR[k]).toMatch(/^var\(--kind-/)
    }
  })

  it('includes the show kind', () => {
    expect(KIND_OPTIONS).toContain('show')
    expect(KIND_LABEL.show).toBe('Show')
  })

  it('lists every kind once, ordered alphabetically by label', () => {
    expect(KIND_OPTIONS).toHaveLength(Object.keys(KIND_VAR).length)
    const labels = KIND_OPTIONS.map(k => KIND_LABEL[k])
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
  })
})
