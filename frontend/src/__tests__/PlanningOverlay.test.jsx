import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import PlanningOverlay from '../components/PlanningOverlay.jsx'

// plan-16d D8: Pointer Events + setPointerCapture, grid-geometry hit testing,
// 300 ms long-press gate on touch. See
// docs/plans/plan-16d-planning-mode.md's "Tests" section for the exact list
// this file covers. PlanningOverlay owns only the gesture state machine (no
// visuals of its own — see the file's header comment), so it's exercised
// here through a minimal render-prop harness rather than the real calendar
// grid.

const WEEK = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']
const STOPS = [{ id: 1, arrive: '2026-09-14T00:00', depart: '2026-09-15T00:00' }]

// The handles are nested INSIDE the band's grab body, exactly like
// TripCalendar.jsx's real markup (the handle `<span>`s sit inside the band
// `<div {...bandGrabProps}>`) — not siblings. That nesting is what makes a
// pointerdown on a handle bubble into the band's own grab handler unless
// bandHandleProps stops propagation itself; a flat sibling layout wouldn't
// exercise that at all.
function Harness({ draft, onDraftChange, onCreateStop, onDeleteStop }) {
  return (
    <PlanningOverlay
      weeks={[WEEK]} originalStops={STOPS} draft={draft} onDraftChange={onDraftChange}
      onCreateStop={onCreateStop} onDeleteStop={onDeleteStop} rowHeight={100}
    >
      {(api) => (
        <div ref={api.gridRef} data-testid="grid">
          <div data-testid="band-1" {...api.bandGrabProps(1)}>
            Band
            <span data-testid="handle-start-1" {...api.bandHandleProps(1, 'start')} />
            <span data-testid="handle-end-1" {...api.bandHandleProps(1, 'end')} />
          </div>
          <div data-testid="empty-cell" {...api.emptyCellProps('2026-09-16')} />
        </div>
      )}
    </PlanningOverlay>
  )
}

// A 700px-wide, single-row (100px tall) grid — 7 columns of 100px each,
// matching WEEK above. Applies to every element (only the grid ref's rect is
// actually read by cellFromPoint).
beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 700, height: 100, right: 700, bottom: 100, x: 0, y: 0, toJSON() {},
  })
})

// jsdom (as of the version this repo pins) has no PointerEvent constructor at
// all, so @testing-library/dom's fireEvent.pointerDown/Move/Up — which need
// `window.PointerEvent` to exist to construct an event carrying clientX/Y —
// silently fall back to a bare `Event` that drops every init property
// (clientX/Y, pointerId, pointerType, button included). React's event
// delegation dispatches on the native event's `type` string, not its
// constructor, so a MouseEvent typed 'pointerdown'/'pointermove'/'pointerup'
// still reaches an onPointerDown/Move/Up prop — this builds one by hand (a
// real, jsdom-supported constructor) and bolts on the Pointer-Event-only
// fields React/PlanningOverlay actually read.
function firePointer(type, el, { clientX, clientY, pointerId = 1, pointerType = 'mouse', button = 0 }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  fireEvent(el, event)
}

function drag(el, { downX, downY = 50, moveX, upX, pointerType = 'mouse' }) {
  firePointer('pointerdown', el, { clientX: downX, clientY: downY, pointerType })
  if (moveX !== undefined) firePointer('pointermove', el, { clientX: moveX, clientY: downY, pointerType })
  firePointer('pointerup', el, { clientX: upX ?? moveX ?? downX, clientY: downY, pointerType })
}

describe('PlanningOverlay — mouse drag', () => {
  it('dragging a band by two columns shifts both dates by +2 days, same duration', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    // col0 (x=50, day 09-14) -> col2 (x=250, day 09-16): delta +2.
    drag(getByTestId('band-1'), { downX: 50, moveX: 250 })
    expect(onDraftChange).toHaveBeenCalledWith({
      moves: { 1: { arrive: '2026-09-16T00:00', depart: '2026-09-17T00:00' } },
      creates: {}, deletes: [],
    })
  })

  it('a plain tap (no movement) does not call onDraftChange', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    drag(getByTestId('band-1'), { downX: 50 })
    expect(onDraftChange).not.toHaveBeenCalled()
  })
})

describe('PlanningOverlay — edge-handle resize', () => {
  it('dragging the end handle changes only depart', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    // col1 (day 09-15) -> col3 (day 09-17): delta +2 on depart only.
    drag(getByTestId('handle-end-1'), { downX: 150, moveX: 350 })
    expect(onDraftChange).toHaveBeenCalledWith({
      moves: { 1: { arrive: '2026-09-14T00:00', depart: '2026-09-17T00:00' } },
      creates: {}, deletes: [],
    })
  })

  it('cannot drag depart before arrive — clamps to arrive', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    // col6 (day 09-20) -> col0 (day 09-14): delta -6 would put depart at
    // 09-09, before arrive (09-14) — must clamp to arrive instead.
    drag(getByTestId('handle-end-1'), { downX: 650, moveX: 50 })
    expect(onDraftChange).toHaveBeenCalledWith({
      moves: { 1: { arrive: '2026-09-14T00:00', depart: '2026-09-14T00:00' } },
      creates: {}, deletes: [],
    })
  })
})

describe('PlanningOverlay — touch long-press gate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a touch move of >8px within 300ms is a scroll, not a drag', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    const band = getByTestId('band-1')
    firePointer('pointerdown', band, { clientX: 50, clientY: 50, pointerType: 'touch' })
    firePointer('pointermove', band, { clientX: 70, clientY: 50, pointerType: 'touch' }) // 20px < 300ms
    act(() => { vi.advanceTimersByTime(300) })
    firePointer('pointerup', band, { clientX: 250, clientY: 50, pointerType: 'touch' })
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('a 300ms hold then move starts a real drag', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    const band = getByTestId('band-1')
    firePointer('pointerdown', band, { clientX: 50, clientY: 50, pointerType: 'touch' })
    act(() => { vi.advanceTimersByTime(300) })
    firePointer('pointermove', band, { clientX: 250, clientY: 50, pointerType: 'touch' })
    firePointer('pointerup', band, { clientX: 250, clientY: 50, pointerType: 'touch' })
    expect(onDraftChange).toHaveBeenCalledWith({
      moves: { 1: { arrive: '2026-09-16T00:00', depart: '2026-09-17T00:00' } },
      creates: {}, deletes: [],
    })
  })
})

describe('PlanningOverlay — Escape cancels', () => {
  it('Escape mid-drag results in no draft change', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    const band = getByTestId('band-1')
    firePointer('pointerdown', band, { clientX: 50, clientY: 50 })
    firePointer('pointermove', band, { clientX: 250, clientY: 50 })
    fireEvent.keyDown(window, { key: 'Escape' })
    firePointer('pointerup', band, { clientX: 250, clientY: 50 })
    expect(onDraftChange).not.toHaveBeenCalled()
  })
})

describe('PlanningOverlay — keyboard access', () => {
  it('ArrowRight on a focused band moves it +1 day', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    fireEvent.keyDown(getByTestId('band-1'), { key: 'ArrowRight' })
    expect(onDraftChange).toHaveBeenCalledWith({
      moves: { 1: { arrive: '2026-09-15T00:00', depart: '2026-09-16T00:00' } },
      creates: {}, deletes: [],
    })
  })

  it('ArrowLeft on a focused band moves it -1 day', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    fireEvent.keyDown(getByTestId('band-1'), { key: 'ArrowLeft' })
    expect(onDraftChange).toHaveBeenCalledWith({
      moves: { 1: { arrive: '2026-09-13T00:00', depart: '2026-09-14T00:00' } },
      creates: {}, deletes: [],
    })
  })

  it('Shift+ArrowRight resizes only the end', () => {
    const onDraftChange = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={onDraftChange} />)
    fireEvent.keyDown(getByTestId('band-1'), { key: 'ArrowRight', shiftKey: true })
    expect(onDraftChange).toHaveBeenCalledWith({
      moves: { 1: { arrive: '2026-09-14T00:00', depart: '2026-09-16T00:00' } },
      creates: {}, deletes: [],
    })
  })

  it('Delete on a focused band calls onDeleteStop', () => {
    const onDeleteStop = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={vi.fn()} onDeleteStop={onDeleteStop} />)
    fireEvent.keyDown(getByTestId('band-1'), { key: 'Delete' })
    expect(onDeleteStop).toHaveBeenCalledWith(1)
  })
})

describe('PlanningOverlay — create-drag', () => {
  it('dragging across empty cells calls onCreateStop with the first/last day', () => {
    const onCreateStop = vi.fn()
    const { getByTestId } = render(<Harness draft={{ moves: {}, creates: {}, deletes: [] }} onDraftChange={vi.fn()} onCreateStop={onCreateStop} />)
    // col2 (09-16) -> col4 (09-18).
    drag(getByTestId('empty-cell'), { downX: 250, moveX: 450 })
    expect(onCreateStop).toHaveBeenCalledWith('2026-09-16', '2026-09-18')
  })
})
