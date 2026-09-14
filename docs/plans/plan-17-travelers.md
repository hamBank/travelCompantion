# Plan 17 — Travelers: who is *on* the trip, separate from who can *edit* it

Read `docs/plans/README.md` first (conventions, test gates, build workflow).
This is the **parent** plan: it fixes the decisions every sub-plan shares and
argues the "why" once. Each sub-plan is one PR, executable on its own by an
agent with no other context; they state these decisions without re-arguing.

| Sub-plan | Scope | Effort | Depends on |
|---|---|---|---|
| [plan-17a-traveler-model-api.md](plan-17a-traveler-model-api.md) | Backend: `Traveler` table + migration (with backfill), encrypted profile, CRUD API with the permission matrix, passport-expiry date warning, docs | M | — |
| [plan-17b-personal-totals.md](plan-17b-personal-totals.md) | Backend + small frontend: personal cross-trip totals key on *traveling*, not membership; `GET /me/travel-totals` (distance + trips + days + countries) | S–M | 17a |
| [plan-17c-travelers-ui.md](plan-17c-travelers-ui.md) | Frontend: Travelers modal — list, owner add/edit/remove, "Add me" / "Edit my details" for editors, decrypt-on-open profile form, "Fill from my vault", age + passport-expiry chips | M–L | 17a |
| Later (see below) | Pick flight passengers from travelers; travelers in PDF export; travelers in the public shared view | — | 17c |

Recommended order: **17a first** (both others depend on it), then **17b and
17c in parallel** (17b is mostly backend + one component; 17c is a new modal —
no shared files beyond `api.js`, where each adds its own helpers).

## Goal

Today "who has access to a trip" (`TripMembership`: owner / editor / viewer)
is the only notion of people on a trip — so a partner who plans the trip but
stays home is counted as traveling, and a child with no account can't be
recorded at all. This plan adds **travelers** as a first-class, separate
list: each trip has the people physically going, optionally linked to a user
account, with the details future automated bookings need (full name as on
passport, date of birth, passport number/expiry/issuing country,
nationality, contact, loyalty numbers). Owners manage the list; an editor
may add and maintain *their own* entry; personal cross-trip totals
(distance today, more later) count a trip only when the user is a traveler
on it.

## Decisions shared by all sub-plans (state, don't re-argue)

### D1. Traveler and membership are different tables, and neither implies the other
`Traveler` rows (new) say who is going. `TripMembership` rows (existing) say
who may view/edit. A traveler may have no account (`user_email` null: a
child, a partner who doesn't use the app). A member may not travel. Creating
a trip does **not** auto-add the creator as a traveler — that assumption is
the bug this plan fixes. The UI offers an explicit "Add me as a traveler."

### D2. Traveler PII is stored *on the trip*, encrypted, never read across from the vault
The document vault (plan 12, `UserDocument`) is owner-only and "never
trip-shared. Full stop." — that decision stands. But automated bookings need
every traveler's passport details in one place the trip owner can use, so
the traveler record carries its own copy: a Fernet-encrypted JSON blob
(`profile_encrypted`) using the existing `backend/document_crypto.py`
(`encrypt_bytes`/`decrypt_bytes`, `DOCUMENT_ENCRYPTION_KEY`, fail-closed
503 via the same `_require_vault_configured` pattern as
`backend/routers/vault.py`). The server **never** decrypts one user's
`UserDocument` to fill another user's traveler row. "Fill from my vault"
(17c) is purely client-side: the signed-in user reads *their own* documents
through the existing `/me/documents/{id}/holder` + `/number` endpoints and
posts the values into *their own* traveler profile.

### D3. What's in the clear vs. encrypted
Clear columns (queryable, in every list response): `id`, `trip_id`,
`user_email` (nullable, lowercase), `display_name`, `age_band`
(`infant` < 2 / `child` < 12 / `adult`, derived — see D5), `passport_expiry`
(date, nullable — needed for the expiry warning without a decrypt),
`has_profile` (bool, derived: blob present), timestamps.
Encrypted (`profile_encrypted`, JSON): `full_name` (as on passport),
`date_of_birth` (`YYYY-MM-DD`), `sex`, `nationality`, `passport_number`,
`passport_issuing_country`, `email`, `phone`, `frequent_flyer`
(`[{airline, number}]`), `meal_preference`, `seat_preference`, `notes`.
Same split rationale as `UserDocument` (expiry/country clear, number/holder
encrypted). Nothing encrypted ever appears in a list/detail response; only
`GET …/travelers/{id}/profile` returns it, decrypt-on-demand.

### D4. Permission matrix (the user's rule, made precise)
| actor | list (clear fields) | read profile | create | update | delete |
|---|---|---|---|---|---|
| owner | ✓ | any traveler | any | any | any |
| editor | ✓ | **own** entry only (`user_email` == self) | own entry only (`user_email` forced to self) | own entry only | own entry only |
| viewer | ✓ (names, age band, expiry) | own entry only | ✗ | ✗ | ✗ |
| no membership | 404 (existing "don't leak existence" rule) | | | | |

"Own entry" = the traveler row whose `user_email` equals the caller's email.
Only an owner may set or change `user_email` on a row to someone else's
address (linking a traveler to another account); an editor's create/update
has `user_email` forced to their own email. A viewer can read their own
profile (it is their PII) but not edit it — "editor role" is the edit gate,
per the request. When auth is disabled everything is owner, as elsewhere.
Not-owned/not-permitted profile reads return **403** (the row is visible in
the list, so 404 would be a lie); a traveler id from another trip → 404.

### D5. Age is derived, never stored as a number
`date_of_birth` lives in the encrypted blob. Airlines care about age **at
travel date**, so the profile response includes `age_at_trip_start`
(computed against `trip.start_date`, falling back to today when the trip is
undated) — never a stored "age" that rots. The clear `age_band` is computed
from the same rule **at write time** (profile save) so the list can show
"child" without decrypting; it is recomputed on every profile save and
documented as a snapshot (a trip whose dates move a year doesn't re-band
until the profile is next saved — acceptable, and 17c shows the exact age in
the profile view).

### D6. Personal totals key on traveling, not membership
`backend/distance.py::compute_user_distance_totals` currently sums every
trip the user has a `TripMembership` on. It changes to sum every trip the
user has a `Traveler` row on (`user_email` match). One helper —
`trip_ids_traveled_by(session, email)` — is the single source for this and
for every future personal aggregate (17b adds trips/days/countries). No
personal aggregate may query `TripMembership` for "which trips count."

### D7. Migration backfill: existing members become travelers once
Today's totals count every member; switching to travelers with no backfill
would zero everyone's lifetime distance the moment this deploys. The
Alembic migration therefore inserts one `Traveler` per existing
`TripMembership` (`user_email` set, `display_name` = the local part of the
email, no profile). That preserves current numbers; owners then *remove*
the members who weren't traveling — pruning a list is a far better
experience than rebuilding one. This is a data migration in the same
revision as the table, written with `op.execute`/`sa.table` (no ORM
imports in migrations), and it must be idempotent-safe (skip if the row
already exists) so a re-run doesn't duplicate.

### D8. Passport expiry is a date warning, like the others
`backend/validation.py`'s `date_warnings` gains one kind,
`passport_expiry`: a traveler whose clear `passport_expiry` is before the
trip's last day **plus six months** (the common entry rule; a constant,
documented) — or null while other travelers have one — gets a warning
naming the traveler's `display_name`. No decrypt needed; surfaces in the
existing `/trips/{id}/date-warnings` panel and the calendar's post-save
warnings (plan 16d) for free.

### D9. Travelers are trip data, so they follow the trip
Deleting a trip deletes its travelers (extend `delete_trip`'s cascade in
`backend/routers/trips.py`, flushing before the trip delete as the
attachment cascade does — Postgres enforces the FK, SQLite doesn't; see the
comment there). Removing a *membership* does **not** remove the traveler
row (they may still be going — the owner decides). Linking is by email only;
there is still no Users table to FK against (same as `TripMembership` and
`UserDocument`).

### D10. Where it lives in the UI
A **Travelers** entry in the hamburger `MenuDropdown` (next to Share), any
role, opening a `TravelersModal` (17c). It is *not* folded into
`ShareModal` — access and attendance are different questions and mixing
them is how the current confusion arose. The modal's header line says the
distinction out loud: "People going on this trip. Access is managed under
Share."

## Later (deliberately not in 17a–17c)
- **Pick flight passengers from travelers**: `details.passengers` on flights
  is `[{name, ticket, loyalty, ff_tier, seat, meal, baggage}]`
  (`PassengersTable.jsx`, `ItemEditModal.jsx`). A "from travelers" picker
  that pre-fills `name`/`loyalty`/`meal` from the traveler's profile (client
  decrypt of the caller's own or owner-visible profiles). Natural follow-on
  to 17c.
- **Travelers in the PDF export** (`backend/pdf_export.py`): names and age
  bands only, never passport data.
- **Travelers (names only) in the public shared view** (`SharedTripView`).
- **Ownership transfer** is still unsupported (`add_member` refuses `owner`);
  unchanged here.
