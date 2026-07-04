# Plan 5 — Trip budget & spend dashboard

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Goal

The app already tracks costs well per item: `item.cost` is a free string like
`"214.20 SGD"`, and `ItemEditModal` writes derived fields into `item.details`
at save time — `converted_cost` (number, in the user's home currency),
`amount_paid`, `converted_amount_paid`, `converted_currency`. What's missing is
the rollup: a per-trip budget number and a "planned / paid / remaining, by
category" summary.

## Part A — backend: `Trip.budget` column

1. `backend/models.py`: add `budget: Optional[str] = None` to **`TripBase`**
   (so `Trip`, `TripCreate`, `TripRead` all inherit it) and to `TripUpdate`.
   It's a cost-style string (`"5000 AUD"`), parsed client-side by the same
   `parseCost` used for item costs — the backend stores it opaquely.
2. Alembic (README §5): `alembic revision --autogenerate -m "add trip budget"`,
   review (should be a single nullable VARCHAR add on `trip`), `alembic
   upgrade head`, `python -m pytest tests/test_alembic_drift.py` green.
3. Confirm PATCH `/trips/{id}` picks it up automatically via `TripUpdate`
   (look at `update_trip` in `backend/routers/trips.py` — it iterates set
   fields; adding to the schema should be sufficient).
4. Backend tests (extend `tests/test_trips.py`): PATCH a budget → read it
   back on GET `/trips/`; PATCH other fields → budget untouched; budget
   clearable with `null`.

## Part B — frontend: aggregation util (pure, tested)

New module `frontend/src/budget.js`:

```js
// items: flat array of ItineraryItems (all stops). homeCurrency: "AUD" etc.
// Returns { planned, paid, byKind: { [kind]: { planned, paid } }, unconvertible: [names] }
export function aggregateSpend(items, homeCurrency)
```

Rules (read `frontend/src/currency.js` — `parseCost`, `getHomeCurrency` — and
`CostDisplay.jsx` before writing, to stay consistent with how the app already
interprets these fields):

- Planned amount for an item: `details.converted_cost` when present (already
  home currency); else `parseCost(item.cost)` when its currency code equals
  `homeCurrency` (or has no code — treat as home); else count the item in
  `unconvertible` and skip its numbers.
- Paid amount: `details.converted_amount_paid` ?? (`details.amount_paid` under
  the same same-currency rule). Items with cost but no paid fields contribute
  0 paid.
- Skip items with no cost entirely. Group by `item.kind`.

Unit tests in `frontend/src/__tests__/budget.test.js` (pure-function style like
`currency.test.js`): converted fields used when present; same-currency raw
parse; foreign-currency-without-conversion lands in `unconvertible`;
kind grouping; paid ≤ planned not enforced (report actuals).

## Part C — frontend: UI

1. **Budget entry.** In `frontend/src/components/EditTrip.jsx` (the trip edit
   view — it already renames trips), add a "Budget" text field patched via the
   existing `updateTrip(id, { budget })` helper in `api.js` (add `budget` to
   the payload; helper already PATCHes arbitrary fields). Placeholder:
   `"5000 AUD"`.
2. **Dashboard.** New component `frontend/src/components/BudgetSummary.jsx`,
   opened from a `💰 Budget` footer button in `App.jsx` (render as a modal
   overlay — copy the structural pattern of an existing simple modal like
   `BagEditModal.jsx`; register Escape-to-close). Contents:
   - Header: planned total vs budget with a progress bar (reuse the packing
     list's bar styling in `PackingList.jsx` — `--accent` fill on
     `--surface-2`, turning `--warning` when planned > budget).
   - Second bar: paid vs planned ("paid up" progress).
   - Per-kind table: kind label (from `KIND_LABEL` in `kinds.js`), planned,
     paid. Sort by planned desc.
   - If `unconvertible.length`: a faint footnote "N costs in other currencies
     not included".
   - No budget set: show the totals anyway with a hint to set a budget in
     Edit trip.
   - Data source: App.jsx already holds `tripStops` (stops incl. items, set by
     TripTimeline's `onStops`) — flatten `tripStops.flatMap(s => s.items)` and
     pass to `aggregateSpend` with `getHomeCurrency()`. If `tripStops` is
     empty because the user is in Packing mode, hide the button in Packing
     mode (same visibility condition as the Export PDF button).
3. Component test (`frontend/src/__tests__/BudgetSummary.test.jsx`): renders
   totals from fixture items; over-budget shows warning color class/style;
   unconvertible footnote appears.

## Manual verification

Trip with: item costing "100 AUD" (paid 50), item with
`converted_cost: 200`, item costing "500 JPY" (no conversion). Home currency
AUD, budget "1000 AUD" → planned 300, paid 50, one unconvertible footnote,
bars proportioned accordingly.

## Gotchas

- `parseCost` handles formats like "1,234.56 USD", "$100", "100" — don't
  reimplement parsing; import it.
- Don't call `convertCurrency` (network) inside the aggregation — the design
  intentionally only sums what's already converted/home-currency.
- Both backend and frontend change here: backend commit doesn't need a build;
  the frontend commit does (build/amend workflow). One combined commit with
  build amended is fine.
