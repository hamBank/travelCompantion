import { describe, it, expect } from 'vitest'
import { countryFacts } from '../countryFacts.js'

describe('countryFacts', () => {
  it('returns a full entry for a known country code', () => {
    const facts = countryFacts('SG')
    expect(facts).toEqual({
      plug: 'Type G',
      voltage: '230V',
      emergency: '999',
      driving: 'left',
      currency: 'SGD',
      tipping: 'Not expected',
    })
  })

  it('is case-insensitive', () => {
    expect(countryFacts('sg')).toEqual(countryFacts('SG'))
    expect(countryFacts('Sg')).toEqual(countryFacts('SG'))
  })

  it('returns null for an unknown code', () => {
    expect(countryFacts('ZZ')).toBeNull()
  })

  it('returns null for blank/missing input', () => {
    expect(countryFacts('')).toBeNull()
    expect(countryFacts(null)).toBeNull()
    expect(countryFacts(undefined)).toBeNull()
  })

  it('spot-check: GB plug is Type G', () => {
    expect(countryFacts('GB').plug).toBe('Type G')
  })

  it('spot-check: SG emergency is 999', () => {
    expect(countryFacts('SG').emergency).toBe('999')
  })

  it('spot-check: US drives on the right', () => {
    expect(countryFacts('US').driving).toBe('right')
  })

  it('spot-check: JP drives on the left', () => {
    expect(countryFacts('JP').driving).toBe('left')
  })

  // Every country covered has all six fields populated with sane values —
  // shape-validated once here rather than per-entry, so new entries are
  // automatically checked without touching this test.
  it('every entry has all six fields as non-empty strings, driving in {left, right}', () => {
    // Reach into the module's coverage via the public codes we know we ship;
    // rather than hardcode the list, walk a broad set of ISO codes and
    // validate whichever ones resolve.
    const candidateCodes = [
      'GB', 'IE', 'FR', 'DE', 'IT', 'ES', 'PT', 'NL', 'BE', 'CH', 'AT', 'LU',
      'GR', 'FI', 'SE', 'NO', 'DK', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG',
      'HR', 'SI', 'RS', 'AL', 'ME', 'MK', 'BA', 'MT', 'CY', 'LV', 'LT', 'EE',
      'UA', 'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'EC', 'UY', 'PA',
      'CR', 'GT', 'DO', 'JM', 'SG', 'JP', 'TH', 'VN', 'MY', 'ID', 'AU', 'NZ',
      'KR', 'CN', 'TW', 'HK', 'PH', 'IN', 'LK', 'KH', 'LA', 'MO', 'AE', 'QA',
      'SA', 'IL', 'TR', 'JO', 'OM', 'KW', 'BH', 'ZA', 'EG', 'MA', 'KE', 'TZ',
      'NG', 'GH', 'TN', 'NA',
    ]
    const resolved = candidateCodes.map(countryFacts).filter(Boolean)
    // Sanity: we expect broad coverage (~80+ countries) per the feature spec.
    expect(resolved.length).toBeGreaterThanOrEqual(80)

    const fields = ['plug', 'voltage', 'emergency', 'driving', 'currency', 'tipping']
    for (const facts of resolved) {
      for (const field of fields) {
        expect(typeof facts[field]).toBe('string')
        expect(facts[field].length).toBeGreaterThan(0)
      }
      expect(['left', 'right']).toContain(facts.driving)
    }
  })
})
