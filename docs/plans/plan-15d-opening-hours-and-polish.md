# Plan 15d — Show stored opening hours in detail modals, plus small polish

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Background: the audit finding this fixes

`opening_hours` is stored on activity, show, restaurant, tour, and
accommodation items (populated by the Google Places auto-fill in
`ItemEditModal.jsx`'s per-kind forms and by imports), but it is **never
displayed anywhere**. It's only *consumed* by `ClosedChip`
(`frontend/src/components/StopCard.jsx` ~line 701) to warn when the venue is
closed on the item's day. The user can't see the hours themselves — data
they collected is illegible.

Format (contract documented on `closedOnDay`, StopCard.jsx ~line 76): a
7-element **Monday-first** array of Google `weekday_text` strings, e.g.
`["Monday: 9:00 AM – 5:00 PM", …, "Sunday: Closed"]`. Legacy items may hold
a plain string instead; `frontend/src/washHours.js` (`filterHoursByDays`)
already handles both shapes gracefully — reuse its tolerance patterns.

Two smaller polish items from the same audit ride along:

- `NoteBody` (`ItemDetailModal.jsx`) doesn't indicate the note's
  `details.important` flag, even though the card styles important notes
  distinctively.
- (Deliberate non-goal: a restaurant `description` field — the form doesn't
  store one; adding a field is product scope, not display parity. Skip.)

## Goal

1. A reusable `HoursRow` in `ItemDetailModal.jsx` that renders stored
   opening hours, highlighting the day relevant to the item; mounted in
   `ActivityBody`, `ShowBody`, `RestaurantBody`, and (if plan 15a has
   landed) `TourBody`. Accommodation is excluded — its hours belong to the
   laundry section it already renders, and hotel reception hours were never
   the point of the field.
2. An "Important" badge in `NoteBody` when `details.important` is set.

## Implementation

All in `frontend/src/components/ItemDetailModal.jsx`.

### `HoursRow`

```jsx
function HoursRow({ hours, forDate }) {
  if (hours == null) return null
  const [expanded, setExpanded] = useState(false)
  // Legacy string form — show as-is on one row.
  if (!Array.isArray(hours)) return <Row label="Hours">{String(hours)}</Row>
  if (hours.length !== 7) return null
  // Monday-first index for the item's own day (same math as closedOnDay).
  let todayLine = null
  const m = typeof forDate === 'string' && forDate.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) {
    const d = new Date(`${forDate.slice(0, 10)}T12:00:00`)
    if (!isNaN(d)) todayLine = hours[(d.getDay() + 6) % 7]
  }
  return (
    <Row label="Hours">
      <span>
        {todayLine ?? 'See all'}
        <button onClick={() => setExpanded(e => !e)}
          style={{ color: 'var(--accent)' }} className="ml-2 text-xs hover:underline">
          {expanded ? 'Hide' : 'All hours'}
        </button>
        {expanded && (
          <span className="block mt-1 space-y-0.5" style={{ color: 'var(--text-muted)' }}>
            {hours.map((line, i) => <span key={i} className="block text-xs">{line}</span>)}
          </span>
        )}
      </span>
    </Row>
  )
}
```

Notes on that sketch (adjust as needed, keep the contract):

- **Never render a false line**: malformed array lengths → render nothing
  (same conservatism as `closedOnDay`).
- `forDate` is the item's own day: pass `item.scheduled_at` (activity, show,
  restaurant, tour). When there's no date, the collapsed row shows the
  expand affordance without a highlighted day.
- `Row` returns null on falsy children, so guard order matters — `HoursRow`
  itself returns the `Row`, don't nest another conditional inside `Row`.
- Rules-of-hooks: `useState` must come before any early return — reorder the
  sketch accordingly (hoist the `useState` above the `hours == null` check).

Mount `<HoursRow hours={d.opening_hours} forDate={item.scheduled_at} />` in:
`ActivityBody` (after the Address row), `ShowBody` (after Venue),
`RestaurantBody` (after Address), `TourBody` if it exists (after Meeting
point). Do not add to `AccommodationBody`.

### Note "Important" badge

In `NoteBody`, when `item.details?.important`, render a small warning-tinted
badge above the notes text — copy the chip styling from the needs-booking
chip in the modal header (~line 893: warning color, tiny uppercase, rounded,
`color-mix` border), text `⚠ Important`.

## Tests

Extend `frontend/src/__tests__/ItemDetailModal.bodies.test.jsx` (create with
the mock shape documented in plan 15a if it doesn't exist yet):

1. An activity with a 7-element hours array and `scheduled_at` on a known
   weekday renders that weekday's line (pick a fixed date, e.g.
   `2026-08-05` = Wednesday → expect the array's index 2 text) and not the
   other six until "All hours" is clicked (`fireEvent.click`, then all
   seven visible).
2. Legacy string hours render as-is.
3. A malformed 5-element array renders no "Hours" label.
4. A note with `details.important` renders `⚠ Important`; without it, does
   not.

## Verification

Browser spot-check (README §Verifying UI changes): seed an activity with a
7-line hours array (curl PATCH with `details.opening_hours`), open its
modal, confirm the item-day line shows and expansion works. Both suites
green: `python -m pytest -q`, `cd frontend && npx vitest run`.

## Ship

Standard PR flow (README §2): source commit → `npm run build` → separate
build commit → push → non-draft PR → auto-merge on green CI.

## Dependency note

Best run AFTER plans 15a/15b (it edits the same bodies 15a creates —
`TourBody` — and shares the new test file). Hard dependency only on 15a's
`TourBody` mount; if 15a hasn't landed, simply skip the TourBody mount and
note it in the PR.
