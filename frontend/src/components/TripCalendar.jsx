import { useMemo } from 'react'
import { itemTimeStr } from './StopCard.jsx'
import { KIND_VAR } from '../kinds.js'
import { useKindFilter } from '../settings.js'
import { tripDateRange, weeksCovering, stopBands, packLanes, itemsByDay } from '../calendarModel.js'

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_CHIPS = 4

function todayKey() {
  return new Date().toLocaleDateString('sv-SE')
}

function monthRange(anchorDay) {
  const [y, m] = anchorDay.split('-').map(Number)
  const first = `${y}-${String(m).padStart(2, '0')}-01`
  const lastDate = new Date(Date.UTC(y, m, 0)) // day 0 of next month = last day of this one
  const last = `${lastDate.getUTCFullYear()}-${String(lastDate.getUTCMonth() + 1).padStart(2, '0')}-${String(lastDate.getUTCDate()).padStart(2, '0')}`
  return { first, last }
}

function fmtShort(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
function fmtShortYear(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
function fmtMonthYear(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}
function fmtPrintedOn() {
  return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
function daysInclusive(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) + 1
}

// A stop-band segment clipped to one displayed week row — a band spanning
// several weeks is drawn once per week it touches (two segments for a stop
// crossing a single week boundary, etc). null when the band doesn't reach
// this week at all.
function bandSegmentForWeek(band, week) {
  const weekStart = week[0], weekEnd = week[6]
  if (band.last < weekStart || band.first > weekEnd) return null
  const segFirst = band.first < weekStart ? weekStart : band.first
  const segLast = band.last > weekEnd ? weekEnd : band.last
  const startCol = week.indexOf(segFirst) + 1
  const endCol = week.indexOf(segLast) + 2 // CSS grid end line is exclusive
  return { startCol, endCol }
}

// Google-Calendar-style Week / Month / Trip grid for a trip's timeline
// (plan-16b). Day view is deliberately not implemented here — it delegates
// to the existing Today-mode day via TripTimeline's `initialDay` prop (see
// App.jsx's onOpenDay), because the per-kind cards, weather banner, layovers
// and detail modals already live there (plan-16 D9).
export default function TripCalendar({ timeline, view = 'trip', anchorDay, onOpenDay, onOpenItem }) {
  const kindFilter = useKindFilter()
  const stops = timeline?.stops || []
  const anchor = anchorDay || todayKey()

  // Lane assignment is computed once over the FULL, unclipped band list so a
  // stop keeps the same lane in every week it appears in — only the pixel
  // segment drawn per week (bandSegmentForWeek) is clipped to that week.
  const packedBands = useMemo(() => packLanes(stopBands(timeline)), [timeline])
  const byDay = useMemo(() => itemsByDay(timeline), [timeline])
  const undatedStops = stops.filter(s => !s.arrive && !s.depart)

  let rangeFirst, rangeLast, headerLabel
  if (view === 'week') {
    const wk = weeksCovering(anchor, anchor)[0] || [anchor, anchor, anchor, anchor, anchor, anchor, anchor]
    rangeFirst = wk[0]; rangeLast = wk[6]
    headerLabel = `${fmtShort(rangeFirst)} – ${fmtShortYear(rangeLast)}`
  } else if (view === 'month') {
    const r = monthRange(anchor)
    rangeFirst = r.first; rangeLast = r.last
    headerLabel = fmtMonthYear(rangeFirst)
  } else {
    const r = tripDateRange(timeline)
    if (!r) {
      return (
        <div className="text-center py-12">
          <p style={{ color: 'var(--text-faint)' }} className="text-sm">Nothing in this trip has a date yet.</p>
        </div>
      )
    }
    rangeFirst = r.first; rangeLast = r.last
    headerLabel = `${fmtShort(rangeFirst)} – ${fmtShortYear(rangeLast)} · ${daysInclusive(rangeFirst, rangeLast)} days`
  }

  const weeks = weeksCovering(rangeFirst, rangeLast)
  const today = todayKey()
  // Screen-only cap (plan-16b); print always shows every chip (plan-16c) —
  // enforced in CSS via `.cal-capped`, not here, so the DOM is identical
  // for screen and print and only the on-screen truncation is CSS.
  const capped = view !== 'week'

  function itemsForDay(day) {
    const items = byDay.get(day) || []
    return kindFilter ? items.filter(i => i.kind === kindFilter) : items
  }

  return (
    <div className="cal-root">
      {/* Print-only title block (hidden on screen, see .print-only in
          index.css) — the app chrome (header/footer) is hidden in print,
          so the printed page needs its own "what is this" line. */}
      <div className="print-only" style={{ marginBottom: '4mm' }}>
        <h1 style={{ color: '#000', fontSize: '14pt', fontWeight: 600, margin: 0 }}>{timeline?.name}</h1>
        <p style={{ color: '#333', fontSize: '9pt', margin: '2px 0 0' }}>
          {`${headerLabel} · printed ${fmtPrintedOn()}`}
        </p>
      </div>

      <div className="flex items-center justify-center mb-3" data-print-hide>
        <h2 style={{ color: 'var(--text)' }} className="text-sm font-medium">{headerLabel}</h2>
      </div>

      <div className="overflow-x-auto cal-grid">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(2.5rem, 1fr))' }}>
          {WEEKDAY_LABELS.map(label => (
            <div key={label} style={{ color: 'var(--text-faint)' }} className="text-[0.65rem] font-medium text-center py-1">
              {label}
            </div>
          ))}
        </div>

        {weeks.map((week, wi) => {
          const weekBands = packedBands
            .map(band => {
              const seg = bandSegmentForWeek(band, week)
              return seg && { ...band, ...seg }
            })
            .filter(Boolean)
          const laneCount = weekBands.reduce((m, b) => Math.max(m, b.lane + 1), 0)

          return (
            <div key={week[0]} className="mb-1 cal-week-row" data-testid="week-row">
              {laneCount > 0 && (
                <div
                  className="grid"
                  style={{ gridTemplateColumns: 'repeat(7, minmax(2.5rem, 1fr))', gridAutoRows: '1.1rem', marginBottom: '0.15rem' }}
                >
                  {weekBands.map(b => (
                    <button
                      key={`${b.stop.id}-${wi}`}
                      data-testid="stop-band"
                      onClick={() => onOpenDay?.(b.first)}
                      title={b.stop.location}
                      className="text-left truncate px-1 rounded text-[0.6rem] font-medium hover:opacity-80 transition-opacity"
                      style={{
                        gridColumn: `${b.startCol} / ${b.endCol}`,
                        gridRow: b.lane + 1,
                        background: `var(--stop-${b.colorIndex + 1})`,
                        color: '#1e1e2e',
                      }}
                    >
                      {b.stop.location}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(2.5rem, 1fr))' }}>
                {week.map(day => {
                  const inRange = day >= rangeFirst && day <= rangeLast
                  const items = itemsForDay(day)
                  // All chips render always — "+N more" only hides the
                  // overflow visually on screen (CSS, `.cal-capped`), so
                  // print (which ignores that rule) shows every chip.
                  const extra = capped ? Math.max(0, items.length - MAX_CHIPS) : 0
                  const isToday = day === today
                  return (
                    <div
                      key={day}
                      data-testid="day-cell"
                      data-day={day}
                      style={{
                        border: '1px solid var(--border)',
                        background: isToday ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
                        opacity: inRange ? 1 : 0.45,
                        minHeight: view === 'week' ? '7rem' : '4.5rem',
                      }}
                      className="p-1 flex flex-col gap-0.5 min-w-0"
                    >
                      <button
                        onClick={() => onOpenDay?.(day)}
                        aria-label={`Open ${day}`}
                        style={{
                          color: isToday ? 'var(--accent)' : 'var(--text-muted)',
                          border: isToday ? '1px solid var(--accent)' : '1px solid transparent',
                        }}
                        className="text-[0.65rem] font-medium hover:opacity-70 transition-opacity self-start rounded-full w-5 h-5"
                      >
                        {Number(day.slice(8, 10))}
                      </button>
                      <div className={`flex flex-col gap-0.5 min-w-0 cal-day-items${capped ? ' cal-capped' : ''}`}>
                        {items.map(item => (
                          <button
                            key={item.id}
                            onClick={() => onOpenItem?.(item)}
                            className="cal-chip flex items-center gap-1 min-w-0 text-left hover:opacity-70 transition-opacity"
                          >
                            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '9999px', background: KIND_VAR[item.kind], flexShrink: 0 }} />
                            <span style={{ color: 'var(--text-faint)' }} className="text-[0.6rem] shrink-0">{itemTimeStr(item)}</span>
                            <span style={{ color: 'var(--text)' }} className="cal-chip-name hidden sm:inline text-[0.6rem] truncate">{item.name}</span>
                          </button>
                        ))}
                        {extra > 0 && (
                          <button
                            data-print-hide
                            onClick={() => onOpenDay?.(day)}
                            style={{ color: 'var(--accent)' }}
                            className="text-[0.6rem] font-medium text-left hover:opacity-70 transition-opacity"
                          >
                            +{extra} more
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {undatedStops.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)' }} className="mt-3 pt-2">
          <p style={{ color: 'var(--text-faint)' }} className="text-[0.65rem] font-medium mb-1">Undated stops</p>
          <div className="flex flex-wrap gap-1.5">
            {undatedStops.map(s => (
              <span key={s.id} style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }} className="text-[0.65rem] px-2 py-0.5 rounded-full">
                {s.location}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
