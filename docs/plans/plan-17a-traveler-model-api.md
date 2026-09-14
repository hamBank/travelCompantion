# Plan 17a — `Traveler` model, migration, encrypted profile, CRUD API (backend only)

Read `docs/plans/README.md` first, then `docs/plans/plan-17-travelers.md`
(D1–D5, D7, D8, D9 are what this sub-plan implements). Backend only: no
`frontend/src/` changes, no build step.

## Goal

A trip can record who is traveling on it — with or without an account —
each with an encrypted booking profile; owners manage the list, editors
manage their own entry, viewers can see names; a passport that expires too
soon shows up as a date warning; existing members are backfilled as
travelers so nothing already counted disappears.

## Files

- **`backend/models.py`** — `Traveler` (table), `TravelerRead`,
  `TravelerCreate`, `TravelerUpdate`, `TravelerProfile` (the decrypted
  shape), `TravelerProfileUpdate`. Place after `TripMembership`.
- **`alembic/versions/<new>_add_traveler_table.py`** — autogenerate, then
  hand-add the D7 backfill. `down_revision` must be the current head (run
  `alembic heads`; at time of writing `a1060f3d2f3b`). `python -m pytest
  tests/test_alembic_drift.py` must stay green.
- **New `backend/travelers.py`** — pure helpers, no FastAPI: `age_at(dob:
  date, on: date) -> int`, `age_band(dob, on) -> str` (`infant` < 2,
  `child` < 12, else `adult`), `PROFILE_FIELDS` (the D3 encrypted key list),
  `encode_profile(dict) -> bytes` / `decode_profile(bytes) -> dict` wrapping
  `document_crypto.encrypt_bytes/decrypt_bytes` and filtering to
  `PROFILE_FIELDS` on the way in, `trip_ids_traveled_by(session, email)`
  (D6 — used by 17b; define it here so 17b has one import).
- **New `backend/routers/travelers.py`** — the routes; register in
  `backend/main.py` next to the other routers (mirror how `vault.router` is
  included). Reuse `_require_vault_configured` semantics: copy the
  three-line check from `backend/routers/vault.py` or, better, move it to
  `backend/document_crypto.py` as `require_configured()` and call it from
  both routers.
- **`backend/permissions.py`** — add `require_traveler_access(session,
  user, traveler_id, *, write: bool) -> (Traveler, TripRole)` implementing
  D4 in one place, so no route hand-rolls the matrix.
- **`backend/validation.py`** — the `passport_expiry` warning (D8), with
  `PASSPORT_VALIDITY_MONTHS = 6`.
- **`backend/routers/trips.py`** — `delete_trip` cascade includes travelers
  (D9).
- **`docs/programmatic-api.md`** — "Travelers" section: list/create/update/
  profile/delete, permission matrix, the encrypted-field list, and a note
  that passport data requires `DOCUMENT_ENCRYPTION_KEY` (same as the vault).
- **`ARCHITECTURE.md`** — Data Model section: one paragraph on
  `Traveler` vs `TripMembership`; "Auth & permissions": the D4 matrix.
- **`tests/test_travelers.py`** — new.

## Model

```python
class Traveler(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    trip_id: int = Field(foreign_key="trip.id", index=True)
    user_email: Optional[str] = Field(default=None, index=True)   # lowercase; None = no account
    display_name: str
    age_band: Optional[str] = None            # "infant" | "child" | "adult", derived (D5)
    passport_expiry: Optional[datetime] = None  # clear, for the D8 warning
    profile_encrypted: Optional[bytes] = Field(default=None, sa_column=Column(LargeBinary))
    created_at / updated_at: datetime         # naive UTC, README convention 3
```
`TravelerRead` = the clear columns + `has_profile: bool`. `TravelerProfile`
= the D3 encrypted keys + `age_at_trip_start: Optional[int]`.
`TravelerProfileUpdate` = the same keys, all optional; `passport_expiry`
is accepted here too and written to the clear column (it's part of the
"passport details" form, but must be queryable).

Uniqueness: at most one traveler per `(trip_id, user_email)` when
`user_email` is set — enforce in the route (409 on duplicate), not as a DB
constraint (nullable unique columns behave differently across SQLite and
Postgres; README convention 5).

## API (all under `/trips/{trip_id}/travelers`, auth required)

| method | path | role (D4) | notes |
|---|---|---|---|
| GET | `/` | viewer | list `TravelerRead`, ordered `display_name` |
| POST | `/` | editor | body `TravelerCreate {display_name, user_email?}`; editor → `user_email` forced to self and 409 if they already have an entry; owner → any `user_email` (or none) |
| PATCH | `/{id}` | owner, or editor on own | `TravelerUpdate {display_name?, user_email?}`; only owner may change `user_email` (editor sending a different value → 403) |
| DELETE | `/{id}` | owner, or editor on own | 204 |
| GET | `/{id}/profile` | owner, or **any role** on own | decrypt-on-demand → `TravelerProfile`; 503 if key unset; 404 `detail="No profile stored"` when blob empty (mirror vault) |
| PUT | `/{id}/profile` | owner, or editor on own | `TravelerProfileUpdate`; merges into the existing decrypted dict, re-encrypts, recomputes `age_band` from `date_of_birth` vs `trip.start_date or today` (D5), writes `passport_expiry` to the clear column; 503 if key unset |
| DELETE | `/{id}/profile` | owner, or editor on own | clears blob, `age_band`, `passport_expiry` |

Error semantics: traveler id not in this trip → 404; permitted-to-list but
not-permitted action → 403; no membership on the trip → 404 (from
`require_trip_role`). Never echo any encrypted field in an error body.

## Date warning (D8)

In `date_warnings(...)`: for each traveler with `passport_expiry` set, if
`passport_expiry.date() < last_trip_day + 6 months` → `{"kind":
"passport_expiry", "traveler_id", "message": "<display_name>'s passport
expires <date>, less than 6 months after the trip ends"}`. `last_trip_day`
= the same range end the calendar uses (max of trip end / stop depart /
item dates — reuse whatever helper `validation.py` already has for the trip
span, don't add a second definition). No warning when no traveler has an
expiry stored (nothing to compare — don't nag).

## Migration backfill (D7)

In the new revision's `upgrade()`, after `create_table`:
```python
conn = op.get_bind()
rows = conn.execute(sa.text("SELECT trip_id, user_email FROM tripmembership")).fetchall()
for trip_id, email in rows:
    conn.execute(sa.text(
        "INSERT INTO traveler (trip_id, user_email, display_name, created_at, updated_at) "
        "SELECT :t, :e, :n, :now, :now WHERE NOT EXISTS "
        "(SELECT 1 FROM traveler WHERE trip_id = :t AND user_email = :e)"),
        {"t": trip_id, "e": email, "n": email.split("@")[0], "now": datetime.utcnow()})
```
`downgrade()` drops the table (the backfilled rows go with it). Tests use
`create_all()`, so also add a unit test that runs the backfill SQL against
a SQLite session with two memberships and asserts two travelers, then
re-runs it and asserts still two.

## Tests (`tests/test_travelers.py`; fixtures from `tests/conftest.py`; look at `tests/test_vault.py` for the encryption-key fixture/monkeypatch pattern and `tests/test_trips.py` for multi-user membership setups)

Unit (`backend/travelers.py`):
- `age_at`: birthday before/after `on` in the year; leap-day DOB.
- `age_band` boundaries: 1y364d → infant, 2y → child, 11y → child, 12y → adult.
- `encode_profile` drops unknown keys; `decode(encode(x)) == x`;
  `decode_profile` raises `DocumentVaultNotConfigured` when key unset.
- `trip_ids_traveled_by`: returns trips with a traveler row for the email
  (case-insensitive), not trips where they're merely a member.

API — permission matrix, one test per cell that matters:
- owner: create (with and without `user_email`), list, patch, delete, read
  any profile, put any profile.
- editor: create forces `user_email` = self; second create → 409; patch own
  ok; patch other → 403; patch own with a different `user_email` → 403;
  delete own ok / other → 403; profile read/put own ok / other → 403.
- viewer: list ok (clear fields only, no encrypted content present in the
  JSON at all); profile read own ok; create/patch/put → 403.
- non-member: list → 404. Traveler id from another trip → 404 for every route.
- profile: put → `has_profile` true, `age_band` and `passport_expiry` set in
  the list, `age_at_trip_start` correct against `trip.start_date` (and
  against today when the trip is undated); get returns every D3 key; merge
  semantics (a put with only `phone` keeps `passport_number`); delete
  profile clears the three derived fields; key unset → 503 on put/get,
  while list/create/patch still work.
- date warning: passport expiring 3 months after the trip → warning with
  the traveler's name; 9 months after → none; no expiries stored → none.
- `delete_trip` removes travelers (assert count 0 after, on the
  `backend-postgres` CI job this is what catches a missing flush).
- programmatic-API smoke: the curl-shaped sequence from the doc works with a
  PAT (there's an existing PAT test pattern in `tests/test_auth.py`).

Run both suites before pushing; open the PR per `CLAUDE.md`.
