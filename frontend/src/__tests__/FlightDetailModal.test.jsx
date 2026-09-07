import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('../api.js', () => ({
  checkFlight: vi.fn(),
  updateItem: vi.fn(),
  updateItemStatus: vi.fn(),
  deleteItem: vi.fn(),
  // AttachmentsSection (mounted via ItemDetailModal.jsx, now shared with
  // FlightDetailModal) fetches its own list on mount.
  listAttachments: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(), deleteAttachment: vi.fn(), fetchAttachmentBlob: vi.fn(),
  // Unused by these tests — stubbed only because offlineQueue.js (imported
  // by DetailActions.jsx) reads these named exports at module load time.
  updateStop: vi.fn(),
  updatePackItem: vi.fn(),
}))

import { updateItemStatus, listAttachments, checkFlight, updateItem } from '../api.js'
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

// Flight/rail have their own dedicated modals instead of the shared
// ItemDetailModal, so they'd previously missed shared chrome added there —
// the attachments section (boarding passes/e-tickets are the most natural
// attachment in the whole app) and the needs-booking chip (a detail any
// kind can carry, set in ItemEditModal's shared chrome).
describe('FlightDetailModal — attachments + needs-booking chip', () => {
  function baseItem(details) {
    return { id: 1, kind: 'flight', name: 'Flight', details }
  }

  it('renders an existing attachment', async () => {
    listAttachments.mockResolvedValue([{ id: 1, filename: 'boarding-pass.pdf', size: 2048 }])
    render(<FlightDetailModal item={baseItem({ flight_number: 'QF37' })} onClose={() => {}} />)
    expect(await screen.findByText(/boarding-pass\.pdf/)).toBeInTheDocument()
  })

  it('shows the needs-booking chip with a book-by date', () => {
    render(
      <FlightDetailModal
        item={baseItem({ flight_number: 'QF37', needs_booking: true, book_by: '2026-08-01' })}
        onClose={() => {}}
      />
    )
    expect(screen.getByText(/Needs booking/)).toBeInTheDocument()
    expect(screen.getByText(/book by/)).toBeInTheDocument()
  })

  it('does not show the needs-booking chip when unset', () => {
    render(<FlightDetailModal item={baseItem({ flight_number: 'QF37' })} onClose={() => {}} />)
    expect(screen.queryByText(/Needs booking/)).not.toBeInTheDocument()
  })
})

// "Flight cards don't seem to have a way of changing the pending status" —
// the collapsed card's leading icon does toggle pending/done, but the user
// was looking in the detail view, which had no such control at all. Confirms
// the shared DetailActions status toggle actually reaches the flight modal.
describe('FlightDetailModal — status toggle', () => {
  it('shows a Done control wired to the item', async () => {
    updateItemStatus.mockResolvedValue({})
    render(
      <FlightDetailModal
        item={{ id: 1, kind: 'flight', name: 'Flight', details: { flight_number: 'QF37', airline: 'Qantas' }, status: 'pending' }}
        onClose={() => {}}
      />
    )
    const btn = screen.getByRole('button', { name: 'Done' })
    fireEvent.click(btn)
    await waitFor(() => expect(updateItemStatus).toHaveBeenCalledWith(1, 'done'))
    expect(await screen.findByRole('button', { name: 'Pending' })).toBeInTheDocument()
  })
})

// Reported: "flight check on a basic populated flight (flight no + departure
// date) reports all match, but ... not populated other details." A field with
// nothing stored has no value to conflict with, so the backend marks it
// `match: null` rather than false — chk()'s ternary is `stored ? (compare) :
// None`. The bug: the check-rows panel (Apply buttons included) only rendered
// when there was a real `match: false` mismatch, so a minimally-populated
// flight — where every comparable field is either an exact match or has
// nothing stored yet (null) — showed "All match" and hid every unfilled
// field's Apply button, with no way to pull in AeroDataBox's origin/
// destination/airline/times/terminals/gates data at all.
describe('FlightDetailModal — check results for a minimally-populated flight', () => {
  function baseItem(details) {
    return { id: 1, kind: 'flight', name: 'Flight', details }
  }

  const nullMatchResult = {
    found: true,
    flight_iata: 'QF37',
    flight_status: null,
    departure_delay_min: null, departure_delay: null,
    arrival_delay_min: null, arrival_delay: null,
    aircraft_position: null,
    checks: [
      // Only depart_time was stored, and it happens to agree — true match.
      { field: 'Depart time', key: 'depart_time', stored: '10:00', live: '10:00', update_value: '2026-07-25T10:00', match: true },
      // Nothing stored for these, but AeroDataBox returned real values.
      { field: 'Origin', key: 'origin', stored: null, live: 'SYD', update_value: 'SYD', match: null },
      { field: 'Destination', key: 'destination', stored: null, live: 'MEL', update_value: 'MEL', match: null },
      { field: 'Airline', key: 'airline', stored: null, live: 'Qantas', update_value: 'Qantas', match: null },
    ],
  }

  it('does not claim "All match" when unfilled fields have live data available', async () => {
    checkFlight.mockResolvedValue(nullMatchResult)
    render(
      <FlightDetailModal
        item={baseItem({ flight_number: 'QF37', depart_time: '2026-07-25T10:00' })}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check flight' }))
    await screen.findByText('Live check · QF37')
    expect(screen.queryByText('All match')).not.toBeInTheDocument()
    expect(screen.getByText(/3 fields to fill in/)).toBeInTheDocument()
  })

  it('shows an Apply button for an unfilled (match: null) field and applies it', async () => {
    checkFlight.mockResolvedValue(nullMatchResult)
    updateItem.mockResolvedValue({
      id: 1, kind: 'flight', name: 'Flight',
      details: { flight_number: 'QF37', depart_time: '2026-07-25T10:00', origin: 'SYD' },
    })
    render(
      <FlightDetailModal
        item={baseItem({ flight_number: 'QF37', depart_time: '2026-07-25T10:00' })}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check flight' }))

    // The Origin row (match: null) must render with its own Apply button —
    // this is exactly what was hidden by the "only when mismatches.length >
    // 0" gate. The field label's immediate parent is that row's own
    // container div, scoping the query to just this row (several other rows
    // also have an Apply button).
    const originRow = (await screen.findByText('Origin')).closest('div')
    const applyBtn = within(originRow).getByRole('button', { name: 'Apply' })
    fireEvent.click(applyBtn)

    await waitFor(() => expect(updateItem).toHaveBeenCalledWith(1, {
      details: { flight_number: 'QF37', depart_time: '2026-07-25T10:00', origin: 'SYD' },
    }))
  })
})
