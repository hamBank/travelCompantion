import { describe, it, expect } from 'vitest'
import { formatStatus, formatPosition, powerbankSummary } from '../components/FlightDetailModal.jsx'
import { getPowerbankPolicy } from '../powerbank.js'

describe('formatStatus', () => {
  it('inserts a space between lower-to-upper transitions', () => {
    expect(formatStatus('EnRoute')).toBe('En Route')
    expect(formatStatus('CheckIn')).toBe('Check In')
    expect(formatStatus('GateClosed')).toBe('Gate Closed')
    expect(formatStatus('CanceledUncertain')).toBe('Canceled Uncertain')
  })

  it('leaves single-word statuses unchanged', () => {
    expect(formatStatus('Delayed')).toBe('Delayed')
    expect(formatStatus('Arrived')).toBe('Arrived')
  })

  it('passes through falsy values', () => {
    expect(formatStatus(null)).toBeNull()
    expect(formatStatus(undefined)).toBeUndefined()
    expect(formatStatus('')).toBe('')
  })
})

describe('formatPosition', () => {
  it('formats full data', () => {
    expect(formatPosition({
      lat: 1.35, lng: 103.99,
      reported_at_utc: '2026-07-24 14:05',
      ground_speed_kt: 480,
      altitude_ft: 36000,
    })).toBe('✈ In the air · 480 kt · 36,000 ft · as of 14:05 UTC')
  })

  it('elides missing pieces independently', () => {
    expect(formatPosition({ lat: 1.35, lng: 103.99, ground_speed_kt: 480 }))
      .toBe('✈ In the air · 480 kt')
    expect(formatPosition({ lat: 1.35, lng: 103.99, altitude_ft: 36000 }))
      .toBe('✈ In the air · 36,000 ft')
    expect(formatPosition({ lat: 1.35, lng: 103.99, reported_at_utc: '2026-07-24 14:05' }))
      .toBe('✈ In the air · as of 14:05 UTC')
  })

  it('shows just the base label when only coordinates are present', () => {
    expect(formatPosition({ lat: 1.35, lng: 103.99 })).toBe('✈ In the air')
  })

  it('returns null for a null position', () => {
    expect(formatPosition(null)).toBeNull()
  })
})

describe('powerbankSummary', () => {
  it('summarizes a prohibited-use policy in one line with the max count', () => {
    expect(powerbankSummary(getPowerbankPolicy('Singapore Airlines')))
      .toBe('In-flight use prohibited · max 2')
  })

  it('summarizes the ICAO default the same way', () => {
    expect(powerbankSummary(getPowerbankPolicy(null)))
      .toBe('In-flight use prohibited · max 2')
  })

  it('omits the max-count clause when the policy text has no digit', () => {
    expect(powerbankSummary({ usage: 'Prohibited', number: 'Not specified' }))
      .toBe('In-flight use prohibited')
  })

  it('reflects an allowed-use policy', () => {
    expect(powerbankSummary({ usage: 'Allowed with restrictions', number: 'Max 3' }))
      .toBe('In-flight use allowed · max 3')
  })
})
