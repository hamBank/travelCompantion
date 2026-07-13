# Permissions & Sharing

Per-trip access control, layered on the existing Google OAuth authentication.
Implemented 2026-06-22.

## Roles

Each user has a role **per trip** (a user can be owner of one trip and viewer of
another). Roles, lowest → highest privilege:

| Role | View | Edit content (stops, items, costs, completion) | Edit trip name/dates | Share / manage members | Delete trip |
|--------|:----:|:----:|:----:|:----:|:----:|
| **viewer** | ✓ | — | — | — | — |
| **editor** | ✓ | ✓ | ✓ | — | — |
| **owner**  | ✓ | ✓ | ✓ | ✓ | ✓ |

- **Owner** is the trip creator. There is exactly one owner; ownership transfer is
  not supported yet.
- **Editor** can make any *content* change but cannot delete the trip or change who
  it's shared with.
- **Viewer** is strictly read-only.

Privilege is monotonic: an endpoint requires "at least" a role
(`ROLE_RANK = {viewer:1, editor:2, owner:3}` in `models.py`).

## Data model

`TripMembership` (one row per user-per-trip):

```
id, trip_id (FK), user_email (lowercased, = JWT subject / Google identity), role, created_at
```

Access is keyed by **email**, which is the Google identity and the JWT `sub`. There
is no separate `User` table — a membership grants access to whoever logs in with
that Google account. (A `User` table for richer profiles is a possible future step.)

Schemas: `MembershipRead`, `MembershipCreate`. Role enum: `TripRole`.

## Authentication (unchanged)

Google OAuth → JWT bearer token (`auth.py`). When `GOOGLE_CLIENT_ID` is unset
(`AUTH_ENABLED = False`, local dev) **all authorization is bypassed** — every
request is treated as `owner` so the app behaves as before.

## Enforcement (backend)

`backend/permissions.py` is the single chokepoint:

- `user_role_for_trip(session, email, trip_id)` → role or None (returns `owner`
  when auth disabled).
- `require_trip_role(session, user, trip_id, minimum)` → raises **404** if the trip
  doesn't exist *or the user has no access at all* (don't leak existence), **403** if
  the user has access but below `minimum`. Returns the actual role.
- `require_stop_role` / `require_item_role` resolve the parent trip from a stop/item
  id, then delegate.

Every trip/stop/item endpoint calls one of these. Summary:

| Action | Required role |
|--------|---------------|
| list trips | returns only trips you're a member of |
| view trip / timeline / stops / items | viewer |
| create/update/delete stop or item, toggle completion, enrich, flight/rail check, gpx upload, sheets backfills | editor |
| create/update/delete a packing bag (incl. nesting, marking packed) | editor |
| create/update/delete a *shared* packing item | editor |
| create/update/delete your own *personal* packing item | viewer (any member) |
| update trip (name/dates) | editor |
| delete trip | owner |
| list members | viewer |
| add/update/remove member | owner |
| import new trip from Sheets | any signed-in user (creator becomes owner) |

The `GET /trips/` list is filtered to the caller's memberships and each item carries
its `role`. `GET /trips/{id}` and `/timeline` also return the caller's `role`
(`TripReadWithRole`), which drives the frontend UI gating.

### Sharing API

```
GET    /trips/{id}/members            → [{user_email, role}]      (viewer+)
POST   /trips/{id}/members            {user_email, role}          (owner)
DELETE /trips/{id}/members/{email}                                (owner)
```

- Cannot grant `owner` via the API, cannot change/remove the existing owner.
- Adding an existing member updates their role (upsert).

## Enforcement (frontend)

Backend is the source of truth (every mutation is authorized server-side). The
frontend gates UI affordances for UX only:

- `roles.js` — `RoleContext`, `useCanEdit()` (editor+), `useCanManage()` (owner),
  defaulting to `owner` when no provider (dev / auth disabled).
- `TripTimeline` wraps its output in `RoleContext.Provider` with the trip's role.
- Gated components: `CardIcon` (completion toggle inert for viewers), `EditPencil`
  (hidden for viewers), `DetailActions` (Edit/Delete hidden for viewers).
- `App`'s hamburger menu: **Edit/View** shown for editor+, **Share** for owner
  (both live in the menu dropdown, not the header/footer directly).
- `TripList`: per-trip role badge for non-owners; trip **Delete** shown only to owner.
- `ShareModal` (owner): invite by email + role, list/remove members.

## Migration of existing data

On startup, `_backfill_trip_ownership()` (in `database.py`) gives every trip with no
membership an `owner` row using `ALLOWED_EMAIL`. If `ALLOWED_EMAIL` is unset nothing
is assigned (auth-disabled dev, where everything is allowed anyway).

## Known limitations / future work

- No ownership transfer; one owner per trip.
- Access keyed by email only — no `User` table / display names for members.
- Inviting an email that never logs in just sits as a pending membership (it
  activates the moment that Google account signs in).
- `ALLOWED_EMAIL` still gates *who may authenticate at all*; per-trip membership
  gates *what they can see*. To let other Google accounts in, `ALLOWED_EMAIL` must
  be cleared or widened (otherwise only that one account can log in).
