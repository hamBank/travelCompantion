# Plan 15a — Detail-modal bodies for Walk, Road Transfer, and Guided Tour

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Background: the audit finding this fixes

`frontend/src/components/ItemDetailModal.jsx` is the shared detail modal for
every item kind that doesn't have a dedicated modal (flight and rail have
their own). Its body dispatches on `item.kind` (around line 917):

```jsx
{item.kind === 'accommodation' && <AccommodationBody item={item} />}
{item.kind === 'activity'      && <ActivityBody item={item} />}
{item.kind === 'show'          && <ShowBody item={item} />}
{item.kind === 'restaurant'    && <RestaurantBody item={item} />}
{item.kind === 'note'          && <NoteBody item={item} />}
{item.kind === 'cycling'       && <CyclingBody item={item} />}
{item.kind === 'hire'          && <HireBody item={item} />}
{item.kind === 'river_transfer' && <RiverTransferBody item={item} />}
```

**`walk`, `transfer`, and `tour` cards all open this modal** (see `WalkCard`,
`TransferCard`, `TourCard` in `frontend/src/components/StopCard.jsx` — each
renders `<ItemDetailModal …>` on card click) **but match none of these
branches**, so the user sees only the header, a generic Notes row, the
attachments section, and the action buttons. Every kind-specific field they
entered is invisible in the detail view. The fields each kind can carry (from
the per-kind forms in `frontend/src/components/ItemEditModal.jsx` — `WalkForm`,
`TransferForm`, `TourForm`):

| Kind | `details` keys stored by its edit form | core |
|---|---|---|
| walk | `start_location`, `end_location`, `distance`, `duration`, `elevation_gain`, `elevation_loss`, `difficulty`, `description`, `maps_url`, `route_points`, plus GPX upload (`gpx_filename`, `original_gpx_name`, `gpx_route`) | `name`, `notes`, `scheduled_at` |
| transfer | `start_location`, `end_location`, `vehicle_type`, `provider`, `distance`, `duration`, `booking_ref`, `cost_per_person`, `maps_url`, `route_points` | `name`, `notes`, `scheduled_at` |
| tour | `operator`, `tour_type`, `meeting_point`, `duration`, `language`, `group_size`, `cost_per_person`, `booking_ref`, `contact_phone`, `opening_hours` | `name`, `notes`, `scheduled_at`, `link` |

`meeting_point` on a tour is the most important single omission — it's the
"where do I need to be" field and currently only shows truncated on the
collapsed card.

## Goal

Add `WalkBody`, `TransferBody`, and `TourBody` components inside
`ItemDetailModal.jsx` and wire them into the kind dispatch, so those three
kinds' detail modals show everything their edit forms can store. Pure
additive frontend UI — no backend change, no schema change, no new API calls.

## Implementation

All work is in `frontend/src/components/ItemDetailModal.jsx` unless noted.
Reuse the existing building blocks in that file — do not invent new ones:

- `Row` — labelled row, renders nothing when the value is falsy.
- `mapsUrl(address)` — Google Maps search link for an address string.
- `GpxMiniMap` — canvas map + elevation chart for an item with a GPX file
  (already generic: takes only `itemId`; currently used by `CyclingBody`).
- `CostDisplay` (imported) — renders `item.cost` with paid state.
- `fmtDateTime` — day + time formatting for `scheduled_at` etc.

Model each new body on the closest existing one. Suggested content:

### `WalkBody` (model on `CyclingBody`)

```jsx
function WalkBody({ item }) {
  const d = item.details ?? {}
  return (
    <>
      {d.gpx_filename && <GpxMiniMap itemId={item.id} />}
      <div className="space-y-0">
        {(d.start_location || d.end_location) && (
          <Row label="Route">{[d.start_location, d.end_location].filter(Boolean).join(' → ')}</Row>
        )}
        {d.difficulty && <Row label="Difficulty"><span className="capitalize">{d.difficulty}</span></Row>}
        {(d.distance || d.elevation_gain || d.elevation_loss) && (
          <Row label="Stats">
            {[d.distance,
              d.elevation_gain && `↑ ${d.elevation_gain}`,
              d.elevation_loss && `↓ ${d.elevation_loss}`].filter(Boolean).join('  ·  ')}
          </Row>
        )}
        {d.duration && <Row label="Duration">{d.duration}</Row>}
        {item.scheduled_at && <Row label="When">{fmtDateTime(item.scheduled_at)}</Row>}
        {d.description && <Row label="Description">{d.description}</Row>}
        {d.maps_url && (
          <Row label="Map">
            <a href={d.maps_url} target="_blank" rel="noreferrer"
               style={{ color: 'var(--accent)' }} className="hover:underline break-all">Open in Google Maps ↗</a>
          </Row>
        )}
        {item.cost && <Row label="Cost"><CostDisplay item={item} showIcon={false} /></Row>}
        {d.gpx_filename && (
          <Row label="GPX">
            <button onClick={() => downloadGpx(item.id, d.original_gpx_name)}
              style={{ color: 'var(--accent)' }} className="hover:underline text-sm text-left">
              ⬇ {d.original_gpx_name || 'route.gpx'}
            </button>
          </Row>
        )}
      </div>
    </>
  )
}
```

Note: `GpxMiniMap`'s canvas draws OSM raster tiles; the walk card's own
"Show map" uses the backend Static-Maps proxy instead. Both are established
patterns — the modal side deliberately mirrors what `CyclingBody` already
does, no new decision needed. Walk items genuinely can carry GPX
(`WalkForm` has the same upload flow as `CyclingForm`).

### `TransferBody` (model on `RiverTransferBody`, minus the river map)

Rows, in order: Route (`start_location → end_location`), Vehicle
(`vehicle_type`, capitalize, optionally with the same icon map `HireBody`
uses — `{ car: '🚗', … }`; a plain capitalized string is also fine), Provider,
Stats (`distance · duration`), When (`item.scheduled_at` via `fmtDateTime`),
Booking ref (`d.booking_ref`), Per person (`d.cost_per_person`), Cost
(`item.cost` via `CostDisplay`), Map (`d.maps_url` link, as in WalkBody).

### `TourBody`

Rows, in order:

- When — `item.scheduled_at` via `fmtDateTime`
- Meeting point — **as a maps link**: `<a href={mapsUrl(d.meeting_point)}…>`
  exactly like `ActivityBody`'s Address row. This is the headline field.
- Operator — `d.operator`
- Type — `d.tour_type` (capitalize)
- Duration — `d.duration`
- Language — `d.language`
- Group size — `d.group_size`
- Phone — `d.contact_phone` as a `tel:` link (copy `ActivityBody`'s Phone row)
- Website — `item.link` (copy `ActivityBody`'s Website row)
- Then a Booking panel (copy the small `border-radius: 0.5rem` panel pattern
  from `RestaurantBody`) shown when `d.booking_ref || item.cost ||
  d.cost_per_person`: Ref (with `CopyText`), Per person, Cost.

### Dispatch + header color

1. Add the three branches to the kind dispatch block:
   ```jsx
   {item.kind === 'walk'     && <WalkBody item={item} />}
   {item.kind === 'transfer' && <TransferBody item={item} />}
   {item.kind === 'tour'     && <TourBody item={item} />}
   ```
2. The `KIND_COLOR` map near the bottom of the file (~line 828) is missing
   `walk`, `transfer`, `tour`, and `show`, so the kind label in the modal
   header renders grey for those kinds. Add all four:
   `walk: 'var(--kind-walk)'`, `transfer: 'var(--kind-transfer)'`,
   `tour: 'var(--kind-tour)'`, `show: 'var(--kind-show)'`.
3. `downloadGpx` is already imported at the top of the file — no import
   changes needed unless you add something new.

### Drive-by fix (same file, trivial)

`WashingEntry` (~line 204) has a **duplicate `style` prop** on the chip
`<span>` — the first (`background: 'var(--surface)'…`) is dead code; JSX
keeps only the second. Merge them into one object (keep the second's values,
add `background: 'var(--surface)'`).

## Tests

Add `frontend/src/__tests__/ItemDetailModal.bodies.test.jsx` following the
render-test pattern of `frontend/src/__tests__/FlightDetailModal.test.jsx`
(that suite exists precisely because a field once silently vanished from a
detail modal — same failure class as this plan fixes). Mock shape:

```jsx
vi.mock('../api.js', () => ({
  fetchGpxText: vi.fn().mockResolvedValue(null),
  downloadGpx: vi.fn(),
  fetchRiverMapBlob: vi.fn().mockResolvedValue(null),
  listAttachments: vi.fn().mockResolvedValue([]),
  uploadAttachment: vi.fn(), deleteAttachment: vi.fn(), fetchAttachmentBlob: vi.fn(),
  updateItemStatus: vi.fn(), deleteItem: vi.fn(),
  // offlineQueue.js (imported via DetailActions) reads these at module load:
  updateItem: vi.fn(), updateStop: vi.fn(), updatePackItem: vi.fn(),
}))
```

Required cases (render `<ItemDetailModal item={…} onClose={vi.fn()} />` and
assert with `screen.getByText`/`queryByText`):

1. A walk item with route/difficulty/stats/duration/description renders each
   value (e.g. `Cinque Terre trailhead → Vernazza`, `moderate`, `12 km`,
   `↑ 450m`).
2. A transfer item with start/end/vehicle/provider/booking_ref renders each —
   **this is the regression test for the reported bug**: these fields
   previously rendered nowhere in the modal.
3. A tour item with meeting_point/operator/language/group_size renders each,
   and the meeting point is an `<a>` whose `href` contains the encoded
   meeting point text.
4. A walk item with `details: {}` renders the modal without crashing and
   without stray labels (`queryByText('Route')` etc. are null).

Do NOT snapshot-test; assert on the specific fields, so the test fails only
when a field disappears.

## Verification

Browser spot-check per README §Verifying UI changes: seed one item of each of
the three kinds with full details via curl, click each card, confirm every
field shows. Existing suites must stay green (`python -m pytest -q`,
`cd frontend && npx vitest run`).

## Ship

Standard PR flow (README §2): source commit → `npm run build` → separate
build commit → push → non-draft PR → auto-merge on green CI.
