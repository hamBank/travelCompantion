import { describe, it, expect } from 'vitest'
import { formatStatus } from '../components/FlightDetailModal.jsx'

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
