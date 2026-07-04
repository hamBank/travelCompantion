import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useContext } from 'react'
import { HideTimeCtx, itemTimeStr, itemDateKey, itemOccursOn, itemSortKey, computeLayovers, computeCrossStopLayover, fmtConnectionDur, toUtcMs, latestCheckoutAccommodation, weatherSegments, routeMapSource } from '../components/StopCard.jsx'

// ── itemTimeStr ──────────────────────────────────────────────────────────────

describe('itemTimeStr', () => {
  it('returns HH:MM AM/PM for flight departure time', () => {
    const item = { kind: 'flight', details: { depart_time: '2026-08-19T16:25' }, scheduled_at: null }
    expect(itemTimeStr(item)).toBe('4:25 PM')
  })

  it('returns HH:MM AM/PM for rail departure time', () => {
    const item = { kind: 'rail', details: { depart_time: '2026-08-20T08:05' }, scheduled_at: null }
    expect(itemTimeStr(item)).toBe('8:05 AM')
  })

  it('returns scheduled_at time for non-transport kinds', () => {
    const item = { kind: 'activity', details: {}, scheduled_at: '2026-08-21T14:30' }
    expect(itemTimeStr(item)).toBe('2:30 PM')
  })

  it('returns empty string when no time component', () => {
    const item = { kind: 'activity', details: {}, scheduled_at: '2026-08-21' }
    expect(itemTimeStr(item)).toBe('')
  })

  it('returns empty string when no datetime at all', () => {
    const item = { kind: 'note', details: {}, scheduled_at: null }
    expect(itemTimeStr(item)).toBe('')
  })

  it('returns midnight as empty (date-only stored as T00:00)', () => {
    const item = { kind: 'transfer', details: {}, scheduled_at: '2026-08-22T00:00' }
    expect(itemTimeStr(item)).toBe('')
  })
})

// ── itemDateKey ──────────────────────────────────────────────────────────────

describe('itemDateKey', () => {
  it('extracts date from flight depart_time', () => {
    const item = { kind: 'flight', details: { depart_time: '2026-08-19T16:25' }, scheduled_at: null }
    expect(itemDateKey(item)).toBe('2026-08-19')
  })

  it('extracts date from scheduled_at for activities', () => {
    const item = { kind: 'activity', details: {}, scheduled_at: '2026-08-21T14:30' }
    expect(itemDateKey(item)).toBe('2026-08-21')
  })

  it('returns null when no datetime', () => {
    const item = { kind: 'note', details: {}, scheduled_at: null }
    expect(itemDateKey(item)).toBeNull()
  })
})

// ── itemOccursOn ─────────────────────────────────────────────────────────────

describe('itemOccursOn', () => {
  const TODAY = '2026-08-21'

  it('activity: true on its own date, false on a different date', () => {
    const item = { kind: 'activity', details: {}, scheduled_at: '2026-08-21T14:30' }
    expect(itemOccursOn(item, TODAY)).toBe(true)
    expect(itemOccursOn(item, '2026-08-22')).toBe(false)
  })

  it('flight: counts if departing OR arriving on the date (a redeye)', () => {
    const redeye = { kind: 'flight', details: { depart_time: '2026-08-20T23:50', arrive_time: '2026-08-21T06:10' } }
    expect(itemOccursOn(redeye, TODAY)).toBe(true)

    const departsToday = { kind: 'flight', details: { depart_time: '2026-08-21T09:00', arrive_time: '2026-08-21T11:00' } }
    expect(itemOccursOn(departsToday, TODAY)).toBe(true)

    const unrelated = { kind: 'flight', details: { depart_time: '2026-08-19T09:00', arrive_time: '2026-08-19T11:00' } }
    expect(itemOccursOn(unrelated, TODAY)).toBe(false)
  })

  it('accommodation: true when the date falls within checkin..checkout inclusive', () => {
    const stay = { kind: 'accommodation', details: { checkin: '2026-08-19T15:00', checkout: '2026-08-23T11:00' } }
    expect(itemOccursOn(stay, TODAY)).toBe(true)
    expect(itemOccursOn(stay, '2026-08-19')).toBe(true)   // checkin day
    expect(itemOccursOn(stay, '2026-08-23')).toBe(true)   // checkout day
    expect(itemOccursOn(stay, '2026-08-24')).toBe(false)  // after checkout
    expect(itemOccursOn(stay, '2026-08-18')).toBe(false)  // before checkin
  })

  it('accommodation: checkin-only (no checkout) only matches its own date', () => {
    const stay = { kind: 'accommodation', details: { checkin: '2026-08-21T15:00' } }
    expect(itemOccursOn(stay, TODAY)).toBe(true)
    expect(itemOccursOn(stay, '2026-08-22')).toBe(false)
  })

  it('dateless items are excluded, except pinned important notes', () => {
    const dateless = { kind: 'activity', details: {}, scheduled_at: null }
    expect(itemOccursOn(dateless, TODAY)).toBe(false)

    const importantNote = { kind: 'note', details: { important: true }, scheduled_at: null }
    expect(itemOccursOn(importantNote, TODAY)).toBe(true)

    const plainNote = { kind: 'note', details: {}, scheduled_at: null }
    expect(itemOccursOn(plainNote, TODAY)).toBe(false)
  })
})

// ── itemSortKey ──────────────────────────────────────────────────────────────

describe('itemSortKey', () => {
  it('orders same-day items by local wall-clock time, ignoring a flight tz offset', () => {
    // Regression: a Singapore (GMT+8) flight departing 21:35 was previously
    // shifted to 13:35 "UTC" for sorting, landing it between two same-day
    // naive-local items (13:00 and 14:00) instead of after both.
    const satay   = { kind: 'restaurant', details: {}, scheduled_at: '2026-07-24T13:00' }
    const gardens = { kind: 'activity',   details: {}, scheduled_at: '2026-07-24T14:00' }
    const flight  = { kind: 'flight', scheduled_at: null,
      details: { depart_time: '2026-07-24T21:35', depart_tz: 'GMT+8' } }
    const ordered = [flight, gardens, satay].sort((a, b) => itemSortKey(a) - itemSortKey(b))
    expect(ordered).toEqual([satay, gardens, flight])
  })
})

// ── routeMapSource ──────────────────────────────────────────────────────────

describe('routeMapSource', () => {
  it('prefers the recorded GPX track over recomputing directions between waypoints', () => {
    const result = routeMapSource({
      gpx_route: [[41.9, 12.5], [41.901, 12.501]],
      route_points: ['Start St, Rome', 'Mid Point, Rome', 'End Ave, Rome'],
    })
    expect(result.hasGpxRoute).toBe(true)
    expect(result.embedUrl).toBeNull()
  })

  it('falls back to a Directions embed built from route_points when there is no GPX track', () => {
    const result = routeMapSource({
      route_points: ['Start St, Rome', 'Mid Point, Rome', 'End Ave, Rome'],
    })
    expect(result.hasGpxRoute).toBe(false)
    expect(result.embedUrl).toContain('output=embed')
  })

  it('falls back to start/end location strings when there are no route_points either', () => {
    const result = routeMapSource({ start_location: 'Rome A', end_location: 'Rome B' })
    expect(result.hasGpxRoute).toBe(false)
    expect(result.embedUrl).toContain('output=embed')
  })

  it('returns no map source at all when details are empty', () => {
    const result = routeMapSource({})
    expect(result.hasGpxRoute).toBe(false)
    expect(result.embedUrl).toBeNull()
    expect(result.mapsLink).toBeNull()
  })

  it('prefers the stored maps_url for the "Open in Maps" link even with a GPX track', () => {
    const result = routeMapSource({
      gpx_route: [[41.9, 12.5], [41.901, 12.501]],
      maps_url: 'https://maps.google.com/original',
    })
    expect(result.mapsLink).toBe('https://maps.google.com/original')
  })

  it('uses the bicycling dirflg for the fallback embed when mode is "b" (cycling card)', () => {
    const result = routeMapSource({ start_location: 'Rome A', end_location: 'Rome B' }, 'b')
    expect(result.embedUrl).toContain('dirflg=b')
  })

  it('still prefers a GPX track over Directions for cycling too', () => {
    const result = routeMapSource({
      gpx_route: [[41.9, 12.5], [41.901, 12.501]],
      start_location: 'Rome A', end_location: 'Rome B',
    }, 'b')
    expect(result.hasGpxRoute).toBe(true)
    expect(result.embedUrl).toBeNull()
  })
})

// ── computeLayovers ──────────────────────────────────────────────────────────

describe('computeLayovers', () => {
  const flight = (id, depart, arrive, origin = 'CDG', destination = 'DOH') => ({
    id,
    kind: 'flight',
    scheduled_at: null,
    details: { depart_time: depart, arrive_time: arrive, origin, destination },
  })
  const transfer = (id, scheduled_at) => ({
    id, kind: 'transfer', scheduled_at, details: {},
  })

  it('detects a connection between two flights within 24h', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:30', 'SYD', 'MEL'),
      flight(2, '2026-08-19T14:00', '2026-08-19T22:00', 'MEL', 'DOH'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeDefined()
    expect(result[1].duration).toBe('3h 30m')
    expect(result[1].location).toMatch(/Melbourne/)
  })

  it('ignores connections longer than 24h', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:00', 'SYD', 'MEL'),
      flight(2, '2026-08-21T08:00', '2026-08-21T14:00', 'MEL', 'DOH'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeUndefined()
  })

  it('sorts items by UTC before computing (out-of-order input is handled)', () => {
    // Pass items in wrong order — algorithm should re-sort and find the 3h 30m connection
    const items = [
      flight(1, '2026-08-19T14:00', '2026-08-19T22:00', 'MEL', 'DOH'),
      flight(2, '2026-08-19T08:00', '2026-08-19T10:30', 'SYD', 'MEL'),
    ]
    const result = computeLayovers(items)
    // After sorting, flight 2 (08:00) precedes flight 1 (14:00) — 3h 30m connection
    expect(result[2]).toBeDefined()
    expect(result[2].duration).toBe('3h 30m')
  })

  it('shows no connection when the next item starts before the transport arrives', () => {
    // Train arrives 10:03; next items at 09:59 and 10:00 — all before arrival, skip
    const rail = (id, depart, arrive) => ({
      id, kind: 'rail', scheduled_at: null,
      details: { depart_time: depart, arrive_time: arrive, origin: 'LYS', destination: 'MAK' },
    })
    const items = [
      rail(1, '2026-08-05T09:16', '2026-08-05T10:03'),
      { id: 2, kind: 'cycling', details: {}, scheduled_at: '2026-08-05T09:59' },
      { id: 3, kind: 'note',    details: {}, scheduled_at: '2026-08-05T10:00' },
      { id: 4, kind: 'cycling', details: {}, scheduled_at: '2026-08-05T12:15' },
    ]
    const result = computeLayovers(items)
    // The immediately next item (09:59) starts before the 10:03 arrival → no connection
    expect(result[1]).toBeUndefined()
  })

  it('ignores a flight whose arrival is after the next item starts', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T22:00', 'SYD', 'MEL'),
      { id: 2, kind: 'activity', details: {}, scheduled_at: '2026-08-19T20:00' },
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeUndefined()
  })

  it('works across flight + transfer pairs', () => {
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:00', 'SYD', 'MEL'),
      transfer(2, '2026-08-19T12:00'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeDefined()
    expect(result[1].duration).toBe('2h')
  })

  it('caps connection at next non-transport activity, not the subsequent flight', () => {
    // Flight arrives 10:00; restaurant at 11:00; next flight at 13:00
    // Connection should be 1h (to restaurant), not 3h (to next flight)
    const items = [
      flight(1, '2026-08-19T08:00', '2026-08-19T10:00', 'SYD', 'MEL'),
      { id: 99, kind: 'restaurant', details: {}, scheduled_at: '2026-08-19T11:00' },
      flight(2, '2026-08-19T13:00', '2026-08-19T22:00', 'MEL', 'DOH'),
    ]
    const result = computeLayovers(items)
    expect(result[1]).toBeDefined()
    expect(result[1].duration).toBe('1h')  // to restaurant, not to flight 2
    expect(result[99]).toBeUndefined()
  })
})

// ── toUtcMs ──────────────────────────────────────────────────────────────────

describe('toUtcMs', () => {
  it('treats no-tz datetime as UTC', () => {
    expect(toUtcMs('2026-07-25T07:35', null)).toBe(new Date('2026-07-25T07:35Z').getTime())
  })

  it('subtracts positive offset to get UTC (GMT+3 → local - 3h = UTC)', () => {
    const local = new Date('2026-07-25T07:35Z').getTime()
    const expected = local - 3 * 3600000
    expect(toUtcMs('2026-07-25T07:35', 'GMT+3')).toBe(expected)
  })

  it('adds negative offset to get UTC (GMT-5 → local + 5h = UTC)', () => {
    const local = new Date('2026-07-25T07:35Z').getTime()
    const expected = local + 5 * 3600000
    expect(toUtcMs('2026-07-25T07:35', 'GMT-5')).toBe(expected)
  })

  it('orders a GMT+10 flight before GMT+2 flight that has a later local time', () => {
    // SGT 21:35 (GMT+8) = 13:35 UTC; HEL 07:35 (GMT+3) next day = 04:35 UTC
    const sgtDep = toUtcMs('2026-07-24T21:35', 'GMT+8')   // 13:35 UTC Jul 24
    const helDep = toUtcMs('2026-07-25T07:35', 'GMT+3')   // 04:35 UTC Jul 25
    expect(sgtDep).toBeLessThan(helDep)
  })

  it('accepts IANA zone names (DST-correct via Intl)', () => {
    // Europe/Helsinki in July = UTC+3
    expect(toUtcMs('2026-07-25T07:35', 'Europe/Helsinki'))
      .toBe(new Date('2026-07-25T07:35Z').getTime() - 3 * 3600000)
    // Asia/Singapore = UTC+8
    expect(toUtcMs('2026-07-24T21:35', 'Asia/Singapore'))
      .toBe(new Date('2026-07-24T21:35Z').getTime() - 8 * 3600000)
  })

  it('matches offset and IANA forms of the same zone', () => {
    expect(toUtcMs('2026-07-25T07:35', 'Europe/Helsinki'))
      .toBe(toUtcMs('2026-07-25T07:35', 'GMT+3'))
  })

  it('falls back to UTC for an unresolvable zone', () => {
    expect(toUtcMs('2026-07-25T07:35', 'Narnia'))
      .toBe(new Date('2026-07-25T07:35Z').getTime())
  })
})

// ── fmtConnectionDur ─────────────────────────────────────────────────────────

describe('fmtConnectionDur', () => {
  it('formats hours and minutes', () => expect(fmtConnectionDur(5700000)).toBe('1h 35m'))
  it('formats whole hours', ()        => expect(fmtConnectionDur(7200000)).toBe('2h'))
  it('formats minutes only', ()       => expect(fmtConnectionDur(2700000)).toBe('45m'))
})

// ── computeCrossStopLayover ───────────────────────────────────────────────────

describe('computeCrossStopLayover', () => {
  const mkFlight = (id, depart, arrive, dest = 'HEL') => ({
    id, kind: 'flight', scheduled_at: null,
    details: { depart_time: depart, arrive_time: arrive, destination: dest },
  })

  it('detects a connection between the last arrival in stop A and first departure in stop B', () => {
    const stopA = { items: [mkFlight(1, '2026-07-24T21:35', '2026-07-25T06:00', 'HEL')] }
    const stopB = { items: [mkFlight(2, '2026-07-25T07:35', '2026-07-25T09:40', 'CDG')] }
    const result = computeCrossStopLayover(stopA, stopB)
    expect(result).not.toBeNull()
    expect(result.duration).toBe('1h 35m')
    expect(result.location).toMatch(/Helsinki/)
  })

  it('returns null when gap is more than 24h', () => {
    const stopA = { items: [mkFlight(1, '2026-07-24T08:00', '2026-07-24T10:00', 'HEL')] }
    const stopB = { items: [mkFlight(2, '2026-07-26T08:00', '2026-07-26T12:00', 'CDG')] }
    expect(computeCrossStopLayover(stopA, stopB)).toBeNull()
  })

  it('returns null when stop A has no transport arrivals', () => {
    const stopA = { items: [{ id: 1, kind: 'restaurant', details: {}, scheduled_at: '2026-07-24T19:00' }] }
    const stopB = { items: [mkFlight(2, '2026-07-25T07:35', '2026-07-25T09:40', 'CDG')] }
    expect(computeCrossStopLayover(stopA, stopB)).toBeNull()
  })

  it('returns null when stop B has no transport departures', () => {
    const stopA = { items: [mkFlight(1, '2026-07-24T21:35', '2026-07-25T06:00', 'HEL')] }
    const stopB = { items: [{ id: 2, kind: 'accommodation', details: {}, scheduled_at: null }] }
    expect(computeCrossStopLayover(stopA, stopB)).toBeNull()
  })

  it('uses the latest arrival when stop A has multiple transport items', () => {
    const stopA = {
      items: [
        mkFlight(1, '2026-07-24T10:00', '2026-07-24T12:00', 'SIN'),
        mkFlight(2, '2026-07-24T21:35', '2026-07-25T06:00', 'HEL'),
      ],
    }
    const stopB = { items: [mkFlight(3, '2026-07-25T07:35', '2026-07-25T09:40', 'CDG')] }
    const result = computeCrossStopLayover(stopA, stopB)
    expect(result.duration).toBe('1h 35m') // from 06:00 not 12:00
  })
})

// ── HideTimeCtx — framed vs frameless ────────────────────────────────────────

describe('HideTimeCtx', () => {
  function ReadCtx() {
    const v = useContext(HideTimeCtx)
    return <span data-testid="val">{String(v)}</span>
  }

  it('is false by default (framed / full-width card view)', () => {
    render(<ReadCtx />)
    expect(screen.getByTestId('val').textContent).toBe('false')
  })

  it('is true when rendered inside HideTimeCtx.Provider', () => {
    render(
      <HideTimeCtx.Provider value={true}>
        <ReadCtx />
      </HideTimeCtx.Provider>
    )
    expect(screen.getByTestId('val').textContent).toBe('true')
  })
})

// ── latestCheckoutAccommodation ──────────────────────────────────────────────
// Regression: a stop can hold multiple accommodation items (e.g. a multi-port
// cruise matched to a single stop) — the "Check out" pill must show the LAST
// checkout, not just the first accommodation item in array order.

describe('latestCheckoutAccommodation', () => {
  const accom = (id, checkout, name = `Hotel ${id}`) => ({
    id, kind: 'accommodation', name, details: { checkout },
  })

  it('returns null when there are no accommodation items', () => {
    expect(latestCheckoutAccommodation([{ id: 1, kind: 'flight', details: {} }])).toBeNull()
  })

  it('returns the single accommodation item when there is only one', () => {
    const item = accom(1, '2026-08-07T18:00')
    expect(latestCheckoutAccommodation([item])).toBe(item)
  })

  it('picks the LATEST checkout even when it is not first in the array', () => {
    // Order mirrors the cruise scenario: Arles checks out on the 7th, but
    // this stop's final (Lyon) checkout on the 13th must win.
    const arles = accom(1, '2026-08-07T18:00', 'AmaKristina')
    const lyon = accom(2, '2026-08-13T09:00', 'AmaKristina')
    expect(latestCheckoutAccommodation([arles, lyon])).toBe(lyon)
  })

  it('handles a bare-date checkout sorting correctly against a full datetime', () => {
    const earlier = accom(1, '2026-08-12')
    const later = accom(2, '2026-08-13T09:00')
    expect(latestCheckoutAccommodation([earlier, later])).toBe(later)
    expect(latestCheckoutAccommodation([later, earlier])).toBe(later)
  })

  it('ignores accommodation items with no checkout', () => {
    const noCheckout = { id: 1, kind: 'accommodation', details: {} }
    const withCheckout = accom(2, '2026-08-07T18:00')
    expect(latestCheckoutAccommodation([noCheckout, withCheckout])).toBe(withCheckout)
  })
})

// ── weatherSegments ──────────────────────────────────────────────────────────
// Regression: a stop with no location of its own (e.g. a multi-port cruise)
// got zero weather for every day, since the fetch effect bailed out entirely
// before ever calling the API. Per-night accommodation items should supply
// their own location for a separate weather look-up when it differs from
// (or simply exists when) the stop has none.

describe('weatherSegments', () => {
  const nightlyAccom = (id, location, checkin, checkout) => ({
    id, kind: 'accommodation', name: 'AmaKristina',
    details: { location, checkin, checkout },
  })

  it('returns one segment per night when the stop has no location at all', () => {
    const stop = { location: '' }
    const items = [
      nightlyAccom(1, 'Arles', '2026-08-06T15:00', '2026-08-07T18:00'),
      nightlyAccom(2, 'Avignon', '2026-08-07T22:00', '2026-08-08T23:59'),
    ]
    const segments = weatherSegments(stop, items)
    expect(segments).toEqual([
      { start: '2026-08-06', end: '2026-08-07', query: 'Arles' },
      { start: '2026-08-07', end: '2026-08-08', query: 'Avignon' },
    ])
  })

  it('skips a night whose location matches the stop (case/whitespace-insensitive)', () => {
    const stop = { location: '  Paris ' }
    const items = [nightlyAccom(1, 'paris', '2026-08-06T15:00', '2026-08-07T12:00')]
    expect(weatherSegments(stop, items)).toEqual([])
  })

  it('only treats a differing location as a separate segment', () => {
    const stop = { location: 'Paris' }
    const items = [
      nightlyAccom(1, 'Paris', '2026-08-06T15:00', '2026-08-07T12:00'),   // matches stop — skipped
      nightlyAccom(2, 'Versailles', '2026-08-07T12:00', '2026-08-08T10:00'), // day trip — separate
    ]
    expect(weatherSegments(stop, items)).toEqual([
      { start: '2026-08-07', end: '2026-08-08', query: 'Versailles' },
    ])
  })

  it('ignores non-accommodation items and items with no location', () => {
    const stop = { location: '' }
    const items = [
      { id: 1, kind: 'flight', details: { origin: 'SIN', destination: 'CDG' } },
      { id: 2, kind: 'accommodation', details: { checkin: '2026-08-06T15:00' } }, // no location
    ]
    expect(weatherSegments(stop, items)).toEqual([])
  })

  it('falls back to a single-day end when checkout is missing', () => {
    const stop = { location: '' }
    const items = [nightlyAccom(1, 'Tournon', '2026-08-09T20:00', null)]
    expect(weatherSegments(stop, items)).toEqual([
      { start: '2026-08-09', end: '2026-08-09', query: 'Tournon' },
    ])
  })
})
