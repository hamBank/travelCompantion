import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../api.js', () => ({
  checkFlight: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
}))

import FlightDetailModal, { formatStatus, formatPosition, powerbankSummary } from '../components/FlightDetailModal.jsx'
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

// Regression: the seatmap link used to be nested inside the Booking panel,
// which only renders when there's a booking ref/cost/link/phone/check-in
// window — so a bare flight (just a flight number and times, nothing booked
// yet, e.g. QF37) never got the panel at all and silently lost the seatmap
// link too, even though the link's own condition was satisfied. This class of
// bug — an independent UI element accidentally gated behind an unrelated
// sibling's visibility condition — is the thing to guard against here, not
// just this one link, so these also check the Booking panel and the
// power-bank panel (which had the same "always independent" fix applied
// deliberately) keep rendering on their own regardless of each other.
describe('FlightDetailModal — independent sections', () => {
  function baseItem(details) {
    return { id: 1, kind: 'flight', name: 'Flight', details }
  }

  it('shows the seatmap link when no booking info has been entered at all', () => {
    render(
      <FlightDetailModal
        item={baseItem({
          flight_number: 'QF37',
          airline: 'Qantas',
          depart_time: '2026-07-25T10:00:00',
          arrive_time: '2026-07-25T18:00:00',
        })}
        onClose={() => {}}
      />
    )
    const link = screen.getByText(/View seatmap on AeroLOPA/)
    expect(link).toBeInTheDocument()
    expect(link.closest('a')).toHaveAttribute('href', 'https://aerolopa.com/QF')
    // No Booking panel should render either, since nothing booking-related was set.
    expect(screen.queryByText('Booking')).not.toBeInTheDocument()
  })

  it('still shows the seatmap link when the Booking panel also renders', () => {
    render(
      <FlightDetailModal
        item={baseItem({
          flight_number: 'QF37',
          airline: 'Qantas',
          booking_ref: 'ABC123',
        })}
        onClose={() => {}}
      />
    )
    expect(screen.getByText('Booking')).toBeInTheDocument()
    expect(screen.getByText(/View seatmap on AeroLOPA/)).toBeInTheDocument()
  })

  it('hides the seatmap link once a passenger already has an assigned seat', () => {
    render(
      <FlightDetailModal
        item={baseItem({
          flight_number: 'QF37',
          airline: 'Qantas',
          passengers: [{ name: 'A Traveller', seat: '14C' }],
        })}
        onClose={() => {}}
      />
    )
    expect(screen.queryByText(/View seatmap on AeroLOPA/)).not.toBeInTheDocument()
  })

  it('hides the seatmap link when the flight number has no resolvable airline code', () => {
    render(
      <FlightDetailModal item={baseItem({ flight_number: '1234' })} onClose={() => {}} />
    )
    expect(screen.queryByText(/View seatmap on AeroLOPA/)).not.toBeInTheDocument()
  })

  it('renders the power bank summary independently of Booking-panel presence', () => {
    render(
      <FlightDetailModal
        item={baseItem({ flight_number: 'QF37', airline: 'Qantas' })}
        onClose={() => {}}
      />
    )
    // No booking info at all — Booking panel absent — but the power bank
    // summary (a sibling, deliberately unrelated section) still shows.
    expect(screen.queryByText('Booking')).not.toBeInTheDocument()
    expect(screen.getByText(/In-flight use/)).toBeInTheDocument()
  })
})
