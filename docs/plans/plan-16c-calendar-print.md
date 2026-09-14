# Plan 16c — Printable calendar

Read `docs/plans/README.md` first, then `docs/plans/plan-16-calendar.md`.
Depends on **16b** (needs `TripCalendar.jsx` and the footer slot it
reserved). Frontend only; two-commit build rule.

## Goal

A **Print** button in calendar mode produces a clean, paper-friendly copy of
the current view (Week / Month / Trip) via the browser's print dialog — no
app chrome, black text on white, stop bands still coloured, one week row
never split across pages. Nothing is sent to the server; the existing
`GET /trips/{id}/export.pdf` (`backend/pdf_export.py`) is the itinerary
*list* export and is not touched.

## Files

- **`frontend/src/index.css`** — a new `@media print` block (there is none
  in the codebase today; grep to confirm). Rules:
  - `body { background: #fff; color: #000 }`; hide `header`, `footer`, the
    offline banner, `[data-print-hide]`, and every `.fixed.inset-0` overlay.
  - `main { padding: 0; }`; the calendar grid `width: 100%`, no max-height,
    no internal scroll (`overflow: visible`).
  - `.cal-week-row { break-inside: avoid; page-break-inside: avoid; }`.
  - `-webkit-print-color-adjust: exact; print-color-adjust: exact;` on band
    and chip elements so stop/kind colours survive "don't print
    backgrounds" defaults. Force readable ink: chips and bands use dark
    text on their light tints in print regardless of theme (`[data-theme]`
    tokens are ignored under print — set explicit hex values here).
  - `@page { margin: 12mm }`. Add `@page { size: landscape }` only inside a
    `.print-landscape` root class that `App.jsx` toggles on `<html>` for
    Week/Trip views (portrait for Month reads better on A4/Letter).
  - Chips print their full name (drop the mobile dot-only rule) at
    `font-size: 8pt`; "+N more" is replaced by the full list (add a
    `data-print-expand` hook in `TripCalendar.jsx` that renders all chips
    when `window.matchMedia('print').matches` — or simply always render all
    chips and let CSS hide the overflow on screen; prefer the latter, it's
    simpler and testable).
- **`frontend/src/components/TripCalendar.jsx`** — a print-only title block
  (`.print-only`, hidden on screen): trip name, view range, "printed
  <date>". Root element gets `data-print-hide` on anything interactive that
  makes no sense on paper (‹ › arrows).
- **`frontend/src/App.jsx`** — **Print** button in the reserved footer
  slot (calendar mode only, any role, online or offline): sets the
  landscape class, calls `window.print()`, removes the class on
  `afterprint`. Icon: lucide `Printer`.

## Tests

- `frontend/src/__tests__/TripCalendar.print.test.jsx`: the print title
  block renders trip name and range; all chips are in the DOM even when a
  day has > 4 (screen truncation is CSS-only).
- `frontend/src/__tests__/App.calendar.test.jsx` (extend from 16b): Print
  button calls `window.print` (spy) and toggles the landscape class on
  `document.documentElement` around it.

Manual check (required — jsdom can't print): Chrome "Save as PDF" for each
of Week/Month/Trip at A4, dark theme active on screen — confirm white
background, coloured bands, no header/footer, no week row split across
pages, and that the on-screen view is unchanged afterwards (landscape class
removed). Mention the result in the PR body.
