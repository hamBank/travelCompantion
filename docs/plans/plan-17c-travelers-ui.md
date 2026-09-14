# Plan 17c — Travelers UI

Read `docs/plans/README.md` first, then `docs/plans/plan-17-travelers.md`
(D1–D5, D10 apply). Depends on **17a** (the API). Frontend only; two-commit
build rule.

## Goal

From the hamburger menu, **Travelers** opens a modal listing who is going on
the trip. Owners add anyone (with or without an account), edit names, link
an entry to a member's email, open and edit any traveler's booking profile,
and remove entries. Editors see "Add me as a traveler" (or "Edit my
details" once added) and can maintain only their own entry. Viewers see the
list and their own profile. Passport details are shown only after an
explicit "Show passport details" tap (decrypt-on-demand) and never cached
in state longer than the form is open. A "Fill from my vault" button
copies the signed-in user's own passport document into their own profile,
client-side only (D2).

## Files

- **`frontend/src/api.js`** — `getTravelers(tripId)`, `createTraveler(tripId,
  body)`, `updateTraveler(id, body)`, `deleteTraveler(id)`,
  `getTravelerProfile(id)`, `putTravelerProfile(id, body)`,
  `deleteTravelerProfile(id)`. Follow `req()`.
- **New `frontend/src/components/TravelersModal.jsx`** — `fixed inset-0
  z-50` wrapper like `ShareModal.jsx` (copy its structure and styling
  conventions). Props: `trip` (with `role`), `userEmail`, `onClose`.
  Sections:
  1. Header: "Travelers" + the D10 line "People going on this trip. Access
     is managed under Share."
  2. List: one row per traveler — `display_name`, chips for `age_band`
     (only `infant`/`child` — adults get no chip), "you" when `user_email`
     matches, a linked-account glyph with the email on hover/title, a
     passport-expiry chip in `--warning` colour when `passport_expiry` is
     within 6 months of the trip's last day (mirror D8's rule client-side
     from the clear field — the same constant, documented as duplicated on
     purpose so the chip appears before a save round-trip). Row actions per
     D4: **Details** (opens the profile panel, enabled when the API would
     permit a read — owner, or own), **Edit name/link** and **Remove**
     (owner, or own entry for editors). All hover-revealed controls carry
     `edit-btn` (README convention 6).
  3. Add: owner sees `display_name` + optional "link to email" (a select of
     current members from `getTripMembers` plus free text); editor sees a
     single **Add me as a traveler** button (posts `{display_name:
     user.name || email local part}`); hidden for viewers; hidden offline
     (`useOnline`).
  4. Profile panel (inline expand under the row, not a nested modal): full
     name, DOB (`type="date"`), sex, nationality, contact email/phone,
     frequent flyer rows (add/remove), meal + seat preference, notes; a
     collapsed **Passport** group behind "Show passport details" that
     fetches the profile only then and reveals number / issuing country /
     expiry (`type="date"`). Shows `age_at_trip_start` next to DOB once
     loaded ("12 at trip start"). **Save** → `putTravelerProfile`; **Clear
     profile** → `deleteTravelerProfile` behind a confirm. 503 from the API
     → an inline "Passport storage isn't configured on this server
     (DOCUMENT_ENCRYPTION_KEY)" message, other fields still editable.
  5. **Fill from my vault** (only on the caller's own entry, only when
     `listDocuments()` returns a `passport`-type document): pick a document
     → client calls `getDocumentHolder(id)` + the number endpoint (both
     already exist in `api.js` — see `DocumentsModal.jsx`) and pre-fills
     full name / DOB / sex / nationality / passport number / issuing
     country / expiry into the form. Nothing is saved until the user taps
     Save. Never available on someone else's entry (the endpoints wouldn't
     allow it anyway; don't render the button).
- **`frontend/src/App.jsx`** — `showTravelers` state; `MenuItem`
  **Travelers** (lucide `Users`) rendered for any role when a trip is open,
  placed after Share; mounts `<TravelersModal trip={selectedTrip}
  userEmail={user?.email} …/>`.
- **`frontend/src/index.css`** — nothing new expected; reuse `--warning`,
  `--accent`, chip styles from `StopCard.jsx`.

## Rules the UI must honour (mirror of D4 — don't invent others)
- Render controls from the trip `role` and `user_email === userEmail`;
  the API is the real gate, so a 403 anywhere shows a toast and reloads the
  list rather than crashing.
- Editors can't change the link email on their own row — don't show that
  field to them.
- Decrypted profile data lives in component state only while the panel is
  open; collapsing the row discards it. Never put it in `localStorage`, the
  offline cache, or `navState`.
- Offline: whole modal is read-only (list only; no Details fetch — it needs
  the network and the decrypt), consistent with `roles.js`'s
  `effectiveRole`.

## Tests (`frontend/src/__tests__/TravelersModal.test.jsx`, `vi.mock('../api.js')`; extend `App` tests for the menu item)

- Owner: list renders names/chips; add with and without link email calls
  `createTraveler` with the right body; Edit name → `updateTraveler`;
  Remove → `deleteTraveler`; Details on any row fetches and shows the
  profile; Save → `putTravelerProfile` with only changed keys merged over
  the loaded profile.
- Editor: sees "Add me" when absent and "Edit my details" when present;
  Edit/Remove/Details only on own row; no link-email field.
- Viewer: no add/edit controls; Details only on own row.
- Passport group is collapsed and `getTravelerProfile` is **not** called
  until "Show passport details"; collapsing the row clears the loaded
  profile from the DOM.
- Expiry chip appears for an expiry 3 months after the trip end, not for
  9 months; child/infant chips from `age_band`.
- "Fill from my vault" appears only on own row with a passport document,
  calls the two vault endpoints, pre-fills the form, and does not call
  `putTravelerProfile` by itself.
- 503 from `putTravelerProfile` shows the not-configured message.
- Offline: no add/edit/details controls.

Manual check (README "Verifying UI changes"): with auth disabled locally
(everything is owner) confirm the full flow; then, to exercise the editor
path, temporarily set `role: 'editor'` on the trip object in React devtools
or via a `TripReadWithRole` mock and confirm the controls collapse to "own
entry only". Phone width and desktop, dark and a light theme.

Run both suites; two-commit build; PR per `CLAUDE.md`.
