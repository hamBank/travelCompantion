# Plan 15b — Detail modals for Purchase and Food & Drink

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Background: the audit finding this fixes

Every itinerary card opens a detail modal on click — **except `PurchaseCard`
and `FoodCard`** (`frontend/src/components/StopCard.jsx`, ~lines 2050 and
2107). Neither has a `showDetail` state; their card body is a plain `<div>`,
not a `<button>`. Consequences:

- `item.notes` is entered in the edit form but **rendered nowhere** for these
  two kinds (other kinds show it in their detail modal).
- No access to the **attachments** section (receipts on a purchase are the
  natural use), the **history** view, or the **Done/Pending status toggle**
  in `DetailActions` — a feature every other kind gained and these two
  silently missed.
- Long `description`/`location` text truncates on the card with no way to
  read it in full.
- Inconsistent tap affordance: these are the only two cards whose surface
  does nothing on tap.

Fields these kinds can carry (from `PurchaseForm` / `FoodForm` in
`frontend/src/components/ItemEditModal.jsx`):

| Kind | `details` | core |
|---|---|---|
| purchase | `description`, `location` | `name`, `notes`, `link`, cost |
| food | `description` | `name`, `notes`, `link`, cost |

## Goal

Give both kinds the standard detail-modal experience via the shared
`ItemDetailModal`, with small kind-specific bodies. This automatically brings
notes display, attachments, history, and the status toggle — all already
built into `ItemDetailModal`'s shared chrome.

## Implementation

### 1. Bodies in `frontend/src/components/ItemDetailModal.jsx`

Model on `ActivityBody` (same file). Keep them small:

```jsx
function PurchaseBody({ item }) {
  const d = item.details ?? {}
  return (
    <div className="space-y-0">
      {d.location && (
        <Row label="Where">
          <a href={mapsUrl(d.location)} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline">{d.location}</a>
        </Row>
      )}
      {d.description && <Row label="Description">{d.description}</Row>}
      {item.link && (
        <Row label="Link">
          <a href={item.link} target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }} className="hover:underline break-all">{item.link}</a>
        </Row>
      )}
      {item.cost && <Row label="Cost"><CostDisplay item={item} /></Row>}
    </div>
  )
}
```

`FoodBody`: identical minus the `location` row (FoodForm doesn't store one).
If preferred, one shared body component with the location row conditional on
kind is equally acceptable — pick whichever reads cleaner.

Wire into the kind dispatch (~line 917) and add both kinds to the
`KIND_COLOR` map (~line 828): `purchase: 'var(--kind-purchase)'`,
`food: 'var(--kind-food)'`.

Note the shared chrome below the dispatch already renders
`item.notes` for every non-note kind and the attachments section — no work
needed there; that's the point of routing through this modal.

### 2. Wire the cards in `frontend/src/components/StopCard.jsx`

For each of `PurchaseCard` (~2050) and `FoodCard` (~2107), mirror what
`TourCard` (~1549) does:

1. Add `const [showDetail, setShowDetail] = useState(false)`.
2. Convert the card's outer content `<div>` into a `<button
   onClick={() => setShowDetail(true)} className="w-full text-left
   hover:opacity-80 transition-opacity" …>` — keep the existing styling
   object. Watch two things:
   - `FoodCard`'s inline link (`↗`) already has `e.stopPropagation()` on its
     onClick — keep it so tapping the link doesn't also open the modal.
     `PurchaseCard`'s link needs `onClick={e => e.stopPropagation()}` added
     for the same reason.
   - `CardIcon` (status toggle) sits inside the new button; check the other
     cards — `CardIcon`'s own click handling already stops propagation
     (it works inside every other card's button), so no change needed there,
     but verify by clicking it in the browser: it must toggle status
     WITHOUT opening the modal.
3. Render the modal alongside the existing `showEdit` one, copying the exact
   prop wiring every other card uses:
   ```jsx
   {showDetail && <ItemDetailModal item={item} onClose={() => setShowDetail(false)}
     onEdit={() => { setShowDetail(false); setShowEdit(true) }}
     onDeleted={onItemDeleted}
     onSave={updated => { setItem(updated); onItemSaved?.(updated) }} />}
   ```

`ItemDetailModal` is already imported in `StopCard.jsx`.

## Tests

Extend (or create, if plan 15a hasn't run yet)
`frontend/src/__tests__/ItemDetailModal.bodies.test.jsx` — see plan 15a for
the required `vi.mock('../api.js', …)` shape (attachments/gpx/status mocks).

1. A purchase item with location/description/link/cost + notes renders each,
   and the location is a maps `<a>`.
2. A food item with description + notes renders both — **the notes assertion
   is the regression test**: notes were previously invisible for these kinds.

Card-side (add to `frontend/src/__tests__/StopCard.test.jsx`, which already
renders cards — follow its existing mock setup):

3. Clicking a purchase card's body opens the detail modal (assert some
   modal-only content appears, e.g. the "Attachments" heading or a
   `Description` row label).
4. Same for a food card.

## Verification

Browser spot-check (README §Verifying UI changes): seed a purchase and a food
item with notes + description via curl; confirm tap opens the modal, notes
show, the status icon still toggles without opening the modal, and the
Done/Pending button in the modal footer works.

Both suites green: `python -m pytest -q`, `cd frontend && npx vitest run`.

## Ship

Standard PR flow (README §2): source commit → `npm run build` → separate
build commit → push → non-draft PR → auto-merge on green CI.

## Dependency note

Independent of plan 15a (touches disjoint dispatch branches; both add
different keys to `KIND_COLOR`). If both run, expect a trivial merge overlap
in the dispatch block and `KIND_COLOR` — rebase and keep both sets.
