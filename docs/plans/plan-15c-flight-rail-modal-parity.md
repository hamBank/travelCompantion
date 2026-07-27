# Plan 15c — Flight/Rail detail-modal parity: attachments + needs-booking chip

Read `docs/plans/README.md` first (conventions, test gates, build workflow).

## Background: the audit finding this fixes

Flight and rail have dedicated detail modals
(`frontend/src/components/FlightDetailModal.jsx`,
`frontend/src/components/RailDetailModal.jsx`) instead of the shared
`ItemDetailModal.jsx`. Two pieces of shared-modal chrome never made it into
them:

1. **Attachments.** `AttachmentsSection` lives inside `ItemDetailModal.jsx`
   and is rendered only there — so flight and rail items have no way to view
   or add attachments, even though boarding passes and e-tickets are the most
   likely attachments in the whole app. The backend API is kind-agnostic
   (`listAttachments(itemId)` etc. in `frontend/src/api.js`); this is purely
   a frontend rendering gap.
2. **The needs-booking chip.** The edit modal offers a `needs_booking`
   checkbox (+ optional `book_by` date) for *every* kind — it's in the
   shared chrome below the per-kind forms in `ItemEditModal.jsx`.
   `ItemDetailModal`'s header renders a "Needs booking · book by …" warning
   chip when set, but the flight/rail modal headers don't, so a flight
   flagged needs-booking gives no cue in its own detail view.

## Goal

Both modals render the attachments section and the needs-booking chip,
identical in behavior and styling to `ItemDetailModal`'s.

## Implementation

### 1. Export `AttachmentsSection` from `ItemDetailModal.jsx`

It's currently a private function component (takes only `{ itemId }`), fully
self-contained (fetches its own data, handles upload/delete/preview, gates
edit affordances on `useCanEdit()`). Add `export` to its declaration:

```jsx
export function AttachmentsSection({ itemId }) { … }
```

Do NOT move it to its own file unless something forces it — a named export
keeps the diff minimal and this repo prefers that (see `powerbankSummary`
exported from `FlightDetailModal.jsx` the same way).

### 2. Mount it in both modals

- `FlightDetailModal.jsx`: import it, render `<AttachmentsSection
  itemId={item.id} />` at the end of the body `<div className="px-5 py-4">`,
  after `<PowerbankPanel airline={d.airline} />`.
- `RailDetailModal.jsx`: same, after the Booking panel block, still inside
  the body div.

### 3. Needs-booking chip in both headers

Copy the chip exactly from `ItemDetailModal.jsx`'s header (~line 893):

```jsx
{item.details?.needs_booking && (
  <span
    style={{
      color: 'var(--warning)',
      border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
      fontSize: '0.6rem',
    }}
    className="shrink-0 px-1.5 py-0.5 rounded uppercase tracking-wide font-medium"
  >
    Needs booking{item.details.book_by ? ` · book by ${fmtDay(item.details.book_by)}` : ''}
  </span>
)}
```

Placement: in each modal's header, directly under the subtitle line
(`flightLabel` / `trainLabel` div), inside the same left-hand header `<div>`.
`fmtDay` is already imported in `FlightDetailModal.jsx`; add it to the
`../dates.js` import in `RailDetailModal.jsx` if missing.

Rather than pasting the chip three times total across the codebase, prefer
extracting it as a tiny exported component (e.g. `export function
NeedsBookingChip({ details })` in `ItemDetailModal.jsx`, used by all three
modals) — same single-source-of-truth reasoning as `isPastPending` in
`StopCard.jsx`.

## Tests

Extend `frontend/src/__tests__/FlightDetailModal.test.jsx` (it already
renders the modal with mocked `../api.js`; you must ADD the attachment API
mocks to its `vi.mock` block: `listAttachments: vi.fn().mockResolvedValue([])`,
`uploadAttachment`, `deleteAttachment`, `fetchAttachmentBlob`):

1. A flight item renders the "Attachments" heading (waitFor — the section
   loads async and returns `null` until loaded; give it a resolved empty
   list and a `canEdit` context or assert on the "+ Add attachment" absence
   accordingly — simplest is `listAttachments` resolving one attachment row
   and asserting its filename appears).
2. A flight with `details.needs_booking: true, book_by: '2026-08-01'`
   renders text matching `/Needs booking/` and `/book by/`.
3. A flight without `needs_booking` does not render `/Needs booking/`.

Create `frontend/src/__tests__/RailDetailModal.test.jsx` with the same three
cases for rail (none exists today; mirror the flight suite's mock shape, and
note `RailDetailModal` imports `checkRail`-style helpers — read its imports
and mock exactly what `../api.js` must provide).

## Verification

Browser spot-check (README §Verifying UI changes): open a flight item,
upload an attachment (any small image), confirm it lists and previews;
set needs-booking + book-by in the edit modal, confirm the chip shows in
the flight detail header. Repeat attachment check on a rail item.

Both suites green: `python -m pytest -q`, `cd frontend && npx vitest run`.

## Ship

Standard PR flow (README §2): source commit → `npm run build` → separate
build commit → push → non-draft PR → auto-merge on green CI.

## Dependency note

Independent of plans 15a/15b, but 15a/15b also edit `ItemDetailModal.jsx`
(different regions: they add body components; this adds `export` keywords
and possibly a chip component). Trivial rebase if they land first.
