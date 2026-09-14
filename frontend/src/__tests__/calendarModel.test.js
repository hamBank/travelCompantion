import { describe, it, expect } from 'vitest'
import {
  tripDateRange, dayKeysBetween, weeksCovering, stopBands, packLanes,
  itemsByDay, shiftPeriod, priorityBandColor,
} from '../calendarModel.js'

describe('tripDateRange', () => {
  it('widens with start_date/end_date and stop/item dates, never narrows', () => {
    const timeline = {
      start_date: '2026-09-10',
      end_date: '2026-09-12',
      stops: [
        { id: 1, arrive: '2026-09-05T10:00', depart: '2026-09-07T10:00', items: [] },
        { id: 2, arrive: null, depart: null, items: [
          { id: 10, kind: 'activity', scheduled_at: '2026-09-20T09:00', details: {} },
        ] },
      ],
    }
    expect(tripDateRange(timeline)).toEqual({ first: '2026-09-05', last: '2026-09-20' })
  })

  it('is null when nothing is dated at all', () => {
    const timeline = { start_date: null, end_date: null, stops: [{ id: 1, arrive: null, depart: null, items: [] }] }
    expect(tripDateRange(timeline)).toBeNull()
  })

  it('is null for a timeline with no stops and no trip dates', () => {
    expect(tripDateRange({ start_date: null, end_date: null, stops: [] })).toBeNull()
  })
})

describe('weeksCovering', () => {
  it('pads to Monday-first weeks covering the whole range', () => {
    // 2026-09-14 is a Monday, 2026-09-16 a Wednesday — exactly one week, no padding.
    const weeks = weeksCovering('2026-09-14', '2026-09-16')
    expect(weeks).toEqual([
      ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'],
    ])
  })

  it('a range starting on Sunday yields a first row with six leading pad days', () => {
    // 2026-09-13 is a Sunday.
    const weeks = weeksCovering('2026-09-13', '2026-09-13')
    expect(weeks).toHaveLength(1)
    expect(weeks[0]).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
    ])
    // Six pad days (Mon-Sat) before the Sunday that actually starts the range.
    expect(weeks[0].indexOf('2026-09-13')).toBe(6)
  })

  it('returns [] when first/last are missing', () => {
    expect(weeksCovering(null, null)).toEqual([])
  })
})

describe('dayKeysBetween', () => {
  it('lists every day inclusive', () => {
    expect(dayKeysBetween('2026-09-14', '2026-09-17')).toEqual([
      '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
    ])
  })
})

describe('stopBands', () => {
  it('arrive-only stop becomes a one-day band', () => {
    const timeline = { stops: [{ id: 1, location: 'Tokyo', arrive: '2026-09-14T10:00', depart: null, items: [] }] }
    expect(stopBands(timeline)).toEqual([{ stop: timeline.stops[0], first: '2026-09-14', last: '2026-09-14', colorIndex: 0, color: null }])
  })

  it('omits fully undated stops', () => {
    const timeline = { stops: [{ id: 1, location: 'Nowhere', arrive: null, depart: null, items: [] }] }
    expect(stopBands(timeline)).toEqual([])
  })

  it('colour index cycles mod 8 by timeline order', () => {
    const stops = Array.from({ length: 10 }, (_, i) => ({ id: i, location: `Stop ${i}`, arrive: '2026-09-14T10:00', depart: '2026-09-15T10:00', items: [] }))
    const bands = stopBands({ stops })
    expect(bands.map(b => b.colorIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1])
  })

  it('a stop with a priority gets a priorityBandColor instead of null', () => {
    const timeline = { stops: [{ id: 5, location: 'Hakone', arrive: '2026-09-14T10:00', depart: '2026-09-15T10:00', priority: 1, items: [] }] }
    const [band] = stopBands(timeline)
    expect(band.color).toBe(priorityBandColor(1, 5))
    expect(band.color).not.toBeNull()
  })
})

describe('priorityBandColor', () => {
  it('is deterministic for the same priority + stop id', () => {
    expect(priorityBandColor(1, 42)).toBe(priorityBandColor(1, 42))
  })

  it('differs between two different priorities for the same stop id', () => {
    expect(priorityBandColor(1, 42)).not.toBe(priorityBandColor(2, 42))
  })

  it('differs between two different stop ids at the same priority', () => {
    expect(priorityBandColor(1, 1)).not.toBe(priorityBandColor(1, 2))
  })

  it('priority 1 is a shade of blue', () => {
    const [, hue] = priorityBandColor(1, 7).match(/^hsl\(([\d.]+)deg/)
    expect(Number(hue)).toBeGreaterThanOrEqual(190)
    expect(Number(hue)).toBeLessThanOrEqual(230)
  })
})

describe('packLanes', () => {
  const band = (id, first, last, priority) => ({ stop: { id, priority }, first, last, colorIndex: 0 })

  it('three mutually overlapping bands get lanes 0, 1, 2', () => {
    const bands = [band('a', '2026-09-01', '2026-09-05'), band('b', '2026-09-02', '2026-09-06'), band('c', '2026-09-03', '2026-09-07')]
    const packed = packLanes(bands)
    expect(packed.map(b => b.lane)).toEqual([0, 1, 2])
  })

  it('back-to-back non-overlapping bands share lane 0', () => {
    const bands = [band('a', '2026-09-01', '2026-09-03'), band('b', '2026-09-04', '2026-09-06')]
    const packed = packLanes(bands)
    expect(packed.every(b => b.lane === 0)).toBe(true)
  })

  it('overlap detection is inclusive of the end day', () => {
    // b starts the same day a ends — that's still an overlap, not back-to-back.
    const bands = [band('a', '2026-09-01', '2026-09-03'), band('b', '2026-09-03', '2026-09-05')]
    const packed = packLanes(bands)
    const byId = Object.fromEntries(packed.map(b => [b.stop.id, b.lane]))
    expect(byId.a).toBe(0)
    expect(byId.b).toBe(1)
  })

  it('a lower priority number wins the top lane over an overlapping unranked stop', () => {
    // 'b' (unranked) starts first chronologically, but 'a' (priority 1)
    // should still land in the top lane — that's the whole point of ranking.
    const bands = [band('b', '2026-09-01', '2026-09-05', undefined), band('a', '2026-09-02', '2026-09-06', 1)]
    const packed = packLanes(bands)
    const byId = Object.fromEntries(packed.map(b => [b.stop.id, b.lane]))
    expect(byId.a).toBe(0)
    expect(byId.b).toBe(1)
  })

  it('a lower priority number wins the top lane over a higher (worse) priority', () => {
    const bands = [band('worse', '2026-09-01', '2026-09-05', 3), band('best', '2026-09-02', '2026-09-06', 1)]
    const packed = packLanes(bands)
    const byId = Object.fromEntries(packed.map(b => [b.stop.id, b.lane]))
    expect(byId.best).toBe(0)
    expect(byId.worse).toBe(1)
  })

  it('same priority falls back to start-day order, same as unranked bands', () => {
    const bands = [band('later', '2026-09-03', '2026-09-06', 1), band('earlier', '2026-09-01', '2026-09-04', 1)]
    const packed = packLanes(bands)
    const byId = Object.fromEntries(packed.map(b => [b.stop.id, b.lane]))
    expect(byId.earlier).toBe(0)
    expect(byId.later).toBe(1)
  })

  it('never puts two genuinely overlapping bands in the same lane, regardless of priority ordering', () => {
    // A deliberately adversarial mix: three mutually-overlapping bands with
    // priorities in a different order than their start dates.
    const bands = [
      band('a', '2026-09-05', '2026-09-10', 3),
      band('b', '2026-09-01', '2026-09-06', 1),
      band('c', '2026-09-03', '2026-09-08', 2),
    ]
    const packed = packLanes(bands)
    const byLane = new Map()
    for (const b of packed) {
      if (!byLane.has(b.lane)) byLane.set(b.lane, [])
      byLane.get(b.lane).push(b)
    }
    for (const laneBands of byLane.values()) {
      for (let i = 0; i < laneBands.length; i++) {
        for (let j = i + 1; j < laneBands.length; j++) {
          const overlap = laneBands[i].first <= laneBands[j].last && laneBands[j].first <= laneBands[i].last
          expect(overlap).toBe(false)
        }
      }
    }
  })
})

describe('itemsByDay', () => {
  it('places a flight on its depart_time day, not scheduled_at, and sorts by itemSortKey', () => {
    const timeline = {
      stops: [{
        id: 1,
        items: [
          { id: 1, kind: 'flight', name: 'Late flight', scheduled_at: '2026-09-14T00:00', details: { depart_time: '2026-09-15T22:00' } },
          { id: 2, kind: 'activity', name: 'Morning walk', scheduled_at: '2026-09-15T08:00', details: {} },
        ],
      }],
    }
    const byDay = itemsByDay(timeline)
    expect(byDay.has('2026-09-14')).toBe(false)
    const day15 = byDay.get('2026-09-15')
    expect(day15.map(i => i.name)).toEqual(['Morning walk', 'Late flight'])
  })

  it('skips items with no placeable date', () => {
    const timeline = { stops: [{ id: 1, items: [{ id: 1, kind: 'note', name: 'Undated note', scheduled_at: null, details: {} }] }] }
    expect(itemsByDay(timeline).size).toBe(0)
  })
})

describe('shiftPeriod', () => {
  it('week: ±7 days', () => {
    expect(shiftPeriod('week', '2026-09-14', 1)).toBe('2026-09-21')
    expect(shiftPeriod('week', '2026-09-14', -1)).toBe('2026-09-07')
  })

  it('month: first of the next/previous month regardless of the anchor day-of-month', () => {
    expect(shiftPeriod('month', '2026-09-14', 1)).toBe('2026-10-01')
    expect(shiftPeriod('month', '2026-09-30', 1)).toBe('2026-10-01')
    expect(shiftPeriod('month', '2026-09-14', -1)).toBe('2026-08-01')
    expect(shiftPeriod('month', '2026-01-05', -1)).toBe('2025-12-01')
  })

  it('trip: no-op', () => {
    expect(shiftPeriod('trip', '2026-09-14', 1)).toBe('2026-09-14')
    expect(shiftPeriod('trip', '2026-09-14', -1)).toBe('2026-09-14')
  })
})
