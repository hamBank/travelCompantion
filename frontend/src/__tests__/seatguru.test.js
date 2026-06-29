import { describe, it, expect } from 'vitest'
import { seatguruUrl } from '../seatguru.js'

// seatguru.js now uses AeroLOPA (aerolopa.com) — SeatGuru shut down Oct 2025.
describe('seatguruUrl → AeroLOPA', () => {
  it('builds AeroLOPA URL for standard flight', () => {
    const url = seatguruUrl('QR 40', '2026-08-19T16:25')
    expect(url).toBe('https://aerolopa.com/QR')
  })

  it('extracts airline from flight number with space', () => {
    expect(seatguruUrl('AY 132', '2026-07-24T21:35')).toBe('https://aerolopa.com/AY')
  })

  it('handles flight number without space', () => {
    expect(seatguruUrl('AZ1620', '2026-08-04T06:20')).toBe('https://aerolopa.com/AZ')
  })

  it('works without date (date param unused)', () => {
    expect(seatguruUrl('QF 37', null)).toBe('https://aerolopa.com/QF')
  })

  it('returns null for missing flight number', () => {
    expect(seatguruUrl(null, '2026-08-19')).toBeNull()
    expect(seatguruUrl('', '2026-08-19')).toBeNull()
  })

  it('returns null when flight number has no recognisable IATA prefix', () => {
    expect(seatguruUrl('12345', '2026-08-19')).toBeNull()
  })
})
