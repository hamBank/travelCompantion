import { useMemo, useState } from 'react'
import { itemTimeStr } from './StopCard.jsx'
import { Field } from './EditStopCard.jsx'
import { KIND_VAR } from '../kinds.js'
import { useKindFilter } from '../settings.js'
import {
  tripDateRange, weeksCovering, stopBands, packLanes, itemsByDay, bandSegmentForWeek,
  applyDraft, shiftDateStr,
} from '../calendarModel.js'
import PlanningOverlay from './PlanningOverlay.jsx'

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
function daysInclusive(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) + 1
}

function isTempStopId(id) { return typeof id === 'string' && id.startsWith('tmp-') }

// A human tooltip for the in-progress gesture PlanningOverlay is tracking —
// "Sep 14 – Sep 17 (4 nights)" for a move/resize, "New stop: …" for a
// create-drag. Computed from the gesture's raw day keys, not from
// applyDraft's preview timeline, since a resize/move ghost needs the
// *candidate* dates before they're committed to the draft.
function ghostLabel(ghost, draft, originalStops) {
  if (!ghost) return ''
  if (ghost.type === 'create') {
    const first = ghost.startDay <= ghost.currentDay ? ghost.startDay : ghost.currentDay
    const last = ghost.startDay <= ghost.currentDay ? ghost.currentDay : ghost.startDay
    return `New stop: ${fmtShort(first)} – ${fmtShortYear(last)} (${daysInclusive(first, last)} night${daysInclusive(first, last) === 1 ? '' : 's'})`
  }
  const move = draft?.moves?.[ghost.stopId]
  const orig = (originalStops || []).find(s => s.id === ghost.stopId)
  let arrive = move?.arrive ?? orig?.arrive ?? null
  let depart = move?.depart ?? orig?.depart ?? null
  const delta = ghost.deltaDays
  if (ghost.type === 'move') {
    arrive = arrive ? shiftDateStr(arrive, delta) : arrive
    depart = depart ? shiftDateStr(depart, delta) : depart
  } else if (ghost.type === 'resize-end') {
    depart = depart ? shiftDateStr(depart, delta) : depart
    if (arrive && depart && depart < arrive) depart = arrive
  } else if (ghost.type === 'resize-start') {
    arrive = arrive ? shiftDateStr(arrive, delta) : arrive
    if (depart && arrive && arrive > depart) arrive = depart
  }
  const a = arrive ? String(arrive).slice(0, 10) : null
  const b = depart ? String(depart).slice(0, 10) : null
  if (!a && !b) return ''
  const nights = a && b ? Math.max(0, daysInclusive(a, b) - 1) : 0
  return `${fmtShort(a || b)} – ${fmtShortYear(b || a)} (${nights} night${nights === 1 ? '' : 's'})`
}

// Google-Calendar-style Week / Month / Trip grid for a trip's timeline
// (plan-16b), plus planning mode (plan-16d, `planning`/`draft`/onDraftChange`):
// an editor drags bands to move/resize stops or across empty cells to create
// one. Day view is deliberately not implemented here — it delegates to the
// existing Today-mode day via TripTimeline's `initialDay` prop (see
// App.jsx's onOpenDay), because the per-kind cards, weather banner, layovers
// and detail modals already live there (plan-16 D9).
export default function TripCalendar({
  timeline, view = 'trip', anchorDay, onOpenDay, onOpenItem,
  planning = false, draft, onDraftChange,
}) {
  const kindFilter = useKindFilter()
  const anchor = anchorDay || todayKey()
  const [placingStopId, setPlacingStopId] = useState(null)
  const [pendingNewStop, setPendingNewStop] = useState(null) // {first, last} while the inline form is open
  const [newStopFields, setNewStopFields] = useState({ location: '', country: '' })

  // In planning mode every render is computed from applyDraft (plan-16d) so
  // bands AND item chips visibly reflect the draft, exactly what Save will
  // do (calendarModel.js's applyDraft mirrors the backend's shift rule).
  // Outside planning mode this is just `timeline` itself — zero behaviour
  // change from plan-16b.
  const displayTimeline = planning ? applyDraft(timeline, draft) : timeline
  const rawStops = timeline?.stops || []
  const stops = displayTimeline?.stops || []

  // Lane assignment is computed once over the FULL, unclipped band list so a
  // stop keeps the same lane in every week it appears in — only the pixel
  // segment drawn per week (bandSegmentForWeek) is clipped to that week.
  const packedBands = useMemo(() => packLanes(stopBands(displayTimeline)), [displayTimeline])
  const byDay = useMemo(() => itemsByDay(displayTimeline), [displayTimeline])
  const undatedStops = stops.filter(s => !s.arrive && !s.depart)

  // Stops the draft marks for deletion still get a band — struck through,
  // pulled from the RAW timeline (applyDraft already omits them from
  // `displayTimeline`) so the Save confirm's "what's being deleted" is
  // visible on the grid, not just in a dialog.
  const deleteIds = planning ? (draft?.deletes || []) : []
  const deletedBands = deleteIds.length
    ? packLanes(stopBands(timeline).filter(b => deleteIds.includes(b.stop.id)))
    : []
  const activeLaneCount = packedBands.reduce((m, b) => Math.max(m, b.lane + 1), 0)
  const offsetDeletedBands = deletedBands.map(b => ({ ...b, lane: b.lane + activeLaneCount, isDeleted: true }))
  const allBands = planning ? [...packedBands, ...offsetDeletedBands] : packedBands
  // Uniform lane-row count across every week only matters in planning mode,
  // where PlanningOverlay needs every week row to be the same pixel height
  // to turn a pointer Y into a (col, row) cell (plan-16 D8). Outside
  // planning each week reserves only the lanes it actually uses, same as
  // plan-16b.
  const globalLaneCount = planning ? Math.max(1, activeLaneCount + offsetDeletedBands.reduce((m, b) => Math.max(m, b.lane + 1 - activeLaneCount), 0)) : null

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
    const r = tripDateRange(displayTimeline)
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
  const maxChips = view === 'week' ? Infinity : MAX_CHIPS

  function itemsForDay(day) {
    const items = byDay.get(day) || []
    return kindFilter ? items.filter(i => i.kind === kindFilter) : items
  }

  function handleDeleteStop(stopId) {
    if (isTempStopId(stopId)) {
      const nextCreates = { ...(draft.creates || {}) }
      delete nextCreates[stopId]
      onDraftChange({ ...draft, creates: nextCreates })
    } else {
      const deletes = draft.deletes || []
      if (!deletes.includes(stopId)) onDraftChange({ ...draft, deletes: [...deletes, stopId] })
    }
  }

  function undeleteStop(stopId) {
    onDraftChange({ ...draft, deletes: (draft.deletes || []).filter(id => id !== stopId) })
  }

  // "Undated stops" strip Place flow: tap Place, then tap a day → the stop
  // becomes a one-day band there. Since the stop was undated, D4's delta is
  // 0 (nothing to be relative to) — its items deliberately don't move.
  function placeStop(stopId, day) {
    onDraftChange({ ...draft, moves: { ...(draft.moves || {}), [stopId]: { arrive: `${day}T00:00`, depart: `${day}T00:00` } } })
    setPlacingStopId(null)
  }

  function handleDayNumberClick(day) {
    if (planning && placingStopId != null) { placeStop(placingStopId, day); return }
    onOpenDay?.(day)
  }

  function submitNewStop(e) {
    e.preventDefault()
    if (!pendingNewStop) return
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    onDraftChange({
      ...draft,
      creates: {
        ...(draft.creates || {}),
        [tempId]: {
          location: newStopFields.location || 'New stop', country: newStopFields.country,
          arrive: `${pendingNewStop.first}T00:00`, depart: `${pendingNewStop.last}T00:00`, timezone: '0',
        },
      },
    })
    setPendingNewStop(null)
    setNewStopFields({ location: '', country: '' })
  }

  function renderGrid(api) {
    return (
      <>
        {api?.ghost && (
          <p style={{ color: 'var(--accent)' }} className="text-center text-xs font-medium mb-1.5">
            {ghostLabel(api.ghost, draft, rawStops)}
          </p>
        )}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(2.5rem, 1fr))' }}>
          {WEEKDAY_LABELS.map(label => (
            <div key={label} style={{ color: 'var(--text-faint)' }} className="text-[0.65rem] font-medium text-center py-1">
              {label}
            </div>
          ))}
        </div>

        <div ref={api?.gridRef}>
          {weeks.map((week, wi) => {
            const weekBands = allBands
              .map(band => {
                const seg = bandSegmentForWeek(band, week)
                return seg && { ...band, ...seg }
              })
              .filter(Boolean)
            const laneCount = globalLaneCount ?? weekBands.reduce((m, b) => Math.max(m, b.lane + 1), 0)

            return (
              <div key={week[0]} className="mb-1" data-testid="week-row">
                {laneCount > 0 && (
                  <div
                    className="grid"
                    style={{ gridTemplateColumns: 'repeat(7, minmax(2.5rem, 1fr))', gridTemplateRows: `repeat(${laneCount}, 1.1rem)`, marginBottom: '0.15rem' }}
                  >
                    {weekBands.map(b => {
                      const isTemp = isTempStopId(b.stop.id)
                      const { style: grabStyle, ...grabProps } = api && !b.isDeleted ? api.bandGrabProps(b.stop.id) : { style: {} }
                      return (
                        <div
                          key={`${b.stop.id}-${wi}`}
                          data-testid={b.isDeleted ? 'stop-band-deleted' : 'stop-band'}
                          role="button"
                          tabIndex={planning && !b.isDeleted ? 0 : -1}
                          onClick={() => {
                            if (b.isDeleted) { undeleteStop(b.stop.id); return }
                            if (!planning) onOpenDay?.(b.first)
                          }}
                          title={b.stop.location}
                          className="text-left truncate px-1 rounded text-[0.6rem] font-medium hover:opacity-80 transition-opacity"
                          style={{
                            gridColumn: `${b.startCol} / ${b.endCol}`,
                            gridRow: b.lane + 1,
                            position: 'relative',
                            background: `var(--stop-${b.colorIndex + 1})`,
                            color: '#1e1e2e',
                            textDecoration: b.isDeleted ? 'line-through' : 'none',
                            opacity: b.isDeleted ? 0.55 : 1,
                            cursor: planning && !b.isDeleted ? 'grab' : 'pointer',
                            ...grabStyle,
                          }}
                          {...grabProps}
                        >
                          {b.stop.location}{isTemp ? ' (new)' : ''}
                          {planning && !b.isDeleted && (() => {
                            const startProps = api.bandHandleProps(b.stop.id, 'start')
                            const endProps = api.bandHandleProps(b.stop.id, 'end')
                            return (
                              <>
                                <span
                                  aria-label="Resize start of stop"
                                  className="edit-btn"
                                  {...startProps}
                                  style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, ...startProps.style }}
                                />
                                <span
                                  aria-label="Resize end of stop"
                                  className="edit-btn"
                                  {...endProps}
                                  style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, ...endProps.style }}
                                />
                                <span
                                  role="button"
                                  aria-label={`Delete ${b.stop.location}`}
                                  className="edit-btn"
                                  onPointerDown={e => e.stopPropagation()}
                                  onClick={e => { e.stopPropagation(); handleDeleteStop(b.stop.id) }}
                                  style={{ position: 'absolute', right: -2, top: -6, width: 12, height: 12, lineHeight: '11px', borderRadius: '9999px', background: 'var(--error)', color: '#fff', fontSize: '0.5rem', textAlign: 'center' }}
                                >
                                  ×
                                </span>
                              </>
                            )
                          })()}
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="grid" style={{ gridTemplateColumns: 'repeat(7, minmax(2.5rem, 1fr))' }}>
                  {week.map(day => {
                    const inRange = day >= rangeFirst && day <= rangeLast
                    const items = itemsForDay(day)
                    const shown = items.slice(0, maxChips)
                    const extra = items.length - shown.length
                    const isToday = day === today
                    const cellProps = planning && api ? api.emptyCellProps(day) : {}
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
                          touchAction: planning ? 'none' : 'auto',
                        }}
                        className="p-1 flex flex-col gap-0.5 min-w-0"
                        {...cellProps}
                      >
                        <button
                          onPointerDown={e => e.stopPropagation()}
                          onClick={() => handleDayNumberClick(day)}
                          aria-label={`Open ${day}`}
                          style={{
                            color: isToday ? 'var(--accent)' : 'var(--text-muted)',
                            border: isToday ? '1px solid var(--accent)' : '1px solid transparent',
                          }}
                          className="text-[0.65rem] font-medium hover:opacity-70 transition-opacity self-start rounded-full w-5 h-5"
                        >
                          {Number(day.slice(8, 10))}
                        </button>
                        <div className="flex flex-col gap-0.5 min-w-0">
                          {shown.map(item => (
                            <button
                              key={item.id}
                              onPointerDown={e => e.stopPropagation()}
                              onClick={() => onOpenItem?.(item)}
                              className="flex items-center gap-1 min-w-0 text-left hover:opacity-70 transition-opacity"
                            >
                              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '9999px', background: KIND_VAR[item.kind], flexShrink: 0 }} />
                              <span style={{ color: 'var(--text-faint)' }} className="text-[0.6rem] shrink-0">{itemTimeStr(item)}</span>
                              <span style={{ color: 'var(--text)' }} className="hidden sm:inline text-[0.6rem] truncate">{item.name}</span>
                            </button>
                          ))}
                          {extra > 0 && (
                            <button
                              onPointerDown={e => e.stopPropagation()}
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
      </>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-center mb-3">
        <h2 style={{ color: 'var(--text)' }} className="text-sm font-medium">{headerLabel}</h2>
      </div>

      {planning && placingStopId != null && (
        <p style={{ color: 'var(--accent)' }} className="text-center text-xs font-medium mb-1.5">
          Tap a day to place this stop there — its items won't move (it had no dates before).
        </p>
      )}

      <div className="overflow-x-auto">
        {planning ? (
          <PlanningOverlay
            weeks={weeks}
            originalStops={rawStops}
            draft={draft}
            onDraftChange={onDraftChange}
            onCreateStop={(first, last) => setPendingNewStop({ first, last })}
            onDeleteStop={handleDeleteStop}
            rowHeight={view === 'week' ? 130 : 90}
          >
            {renderGrid}
          </PlanningOverlay>
        ) : renderGrid(null)}
      </div>

      {pendingNewStop && (
        <form onSubmit={submitNewStop} style={{ background: 'var(--surface)', border: '1px solid var(--border)' }} className="mt-3 p-3 rounded-lg space-y-2">
          <p style={{ color: 'var(--text-faint)' }} className="text-xs uppercase tracking-wide">
            New stop · {fmtShort(pendingNewStop.first)} – {fmtShortYear(pendingNewStop.last)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Field label="City / location" value={newStopFields.location} onChange={v => setNewStopFields(f => ({ ...f, location: v }))} placeholder="Hakone" span={2} />
            <Field label="Country" value={newStopFields.country} onChange={v => setNewStopFields(f => ({ ...f, country: v }))} placeholder="Japan" />
          </div>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setPendingNewStop(null)} style={{ color: 'var(--text-faint)' }} className="text-xs px-2 py-1">Cancel</button>
            <button type="submit" style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }} className="text-xs px-3 py-1 rounded-lg font-medium">Add stop</button>
          </div>
        </form>
      )}

      {undatedStops.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)' }} className="mt-3 pt-2">
          <p style={{ color: 'var(--text-faint)' }} className="text-[0.65rem] font-medium mb-1">Undated stops</p>
          <div className="flex flex-wrap gap-1.5">
            {undatedStops.map(s => (
              <span key={s.id} style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }} className="text-[0.65rem] pl-2 pr-1 py-0.5 rounded-full flex items-center gap-1">
                {s.location}
                {planning && (
                  <button
                    onClick={() => setPlacingStopId(id => (id === s.id ? null : s.id))}
                    style={{ color: 'var(--accent)' }}
                    className="edit-btn text-[0.6rem] font-medium px-1 rounded hover:opacity-70"
                  >
                    {placingStopId === s.id ? 'Cancel' : 'Place'}
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
