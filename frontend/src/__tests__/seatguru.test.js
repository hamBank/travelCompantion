import { describe, it, expect } from 'vitest'
import { seatguruUrl } from '../seatguru.js'

describe('seatguruUrl', () => {
  it('builds URL for standard flight', () => {
    const url = seatguruUrl('QR 40', '2026-08-19T16:25')
    expect(url).toContain('seatguru.com')
    expect(url).toContain('airline=QR')
    expect(url).toContain('flight=40')
    expect(url).toContain('date=2026-08-19')
  })

  it('strips space from flight number', () => {
    const url = seatguruUrl('AY 132', '2026-07-24T21:35')
    expect(url).toContain('airline=AY')
    expect(url).toContain('flight=132')
  })

  it('handles flight number without space', () => {
    const url = seatguruUrl('AZ1620', '2026-08-04T06:20')
    expect(url).toContain('airline=AZ')
    expect(url).toContain('flight=1620')
  })

  it('works without date', () => {
    const url = seatguruUrl('QF 37', null)
    expect(url).toContain('airline=QF')
    expect(url).toContain('flight=37')
    expect(url).not.toContain('date=')
  })

  it('returns null for missing flight number', () => {
    expect(seatguruUrl(null, '2026-08-19')).toBeNull()
    expect(seatguruUrl('', '2026-08-19')).toBeNull()
  })

  it('returns null when flight number has no recognisable IATA prefix', () => {
    expect(seatguruUrl('12345', '2026-08-19')).toBeNull()
  })
})
