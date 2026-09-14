# Programmatic API — creating trips without the browser

This describes how to create trips (and their stops and itinerary items) over
HTTP from a script, a scheduled job, or an AI agent (e.g. a Claude session),
using the app's existing REST endpoints. It covers the two things that aren't
obvious from the endpoints themselves: **authentication** and the **create
flow**.

Scope: creating trips/stops/items (§3), and rescheduling stops — moving,
creating and deleting them atomically, with their items' dates following
along (§6). Other updates and deletes are intentionally out of scope for
now — the endpoints exist, but this document doesn't cover them.

---

## 1. Base URL

| Environment | Base URL |
|-------------|----------|
| Production  | `https://tripplan.hups.club` |
| Local dev   | `http://localhost:8000` |

All paths below are relative to the base URL.

---

## 2. Authentication

The API authenticates with a **bearer token** (`Authorization: Bearer <token>`).
Interactive users get one by signing in with Google in the web app; for
programmatic use you mint a long-lived **personal access token (PAT)**.

> A PAT grants the **same full access as signing in** — it can read and write
> everything in your account. Treat it like a password: don't commit it, don't
> paste it anywhere shared. Each token is **individually revocable** (§2d) and
> also self-expires (default one year). The full token string is shown **only
> once**, when you mint it — only its id is stored, so save it then.

### 2a. One-time bootstrap — get a session token from the browser

You need an existing signed-in session to mint a PAT. In the web app:

1. Sign in normally.
2. Open your browser's devtools console and run:
   ```js
   localStorage.getItem('tc-token')
   ```
   Copy the string it prints — that's your current session token (valid ~30
   days).

### 2b. Mint a personal access token

Exchange the session token for a long-lived PAT:

```bash
curl -X POST https://tripplan.hups.club/me/api-token \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"days": 365, "label": "trip-importer"}'
```

Response:

```json
{
  "id": 3,
  "token": "eyJhbGciOiJIUzI1NiIsIn...",
  "token_type": "bearer",
  "label": "trip-importer",
  "expires_at": "2027-08-27T21:20:33.123456",
  "email": "you@example.com"
}
```

- `days` is optional and clamped to `[1, API_TOKEN_EXPIRE_DAYS]` (server default
  365). `label` is an optional name to recognise the token later. Omit the body
  entirely for the default lifetime and no label.
- Store `token` — it's shown **only here**. `id` is what you revoke by (§2d).
- `expires_at` (here and in §2d's list) is a plain ISO datetime with **no
  timezone suffix** — it's always UTC, same convention as every other
  timestamp the API returns.

If auth isn't configured on the server (`GOOGLE_CLIENT_ID` unset — local dev),
every request is already the `dev@local` user and no token is needed.

### 2c. Use the token

```
Authorization: Bearer <token>
```

Quick check that it works:

```bash
curl https://tripplan.hups.club/auth/me -H "Authorization: Bearer $TOKEN"
# → {"email":"you@example.com","name":"...","picture":"..."}
```

### 2d. List and revoke tokens

List your tokens (never the secret — id, label, timestamps, and `revoked_at`):

```bash
curl https://tripplan.hups.club/me/api-tokens -H "Authorization: Bearer $TOKEN"
# → [{"id":3,"label":"trip-importer","created_at":"...","expires_at":"...","revoked_at":null}]
```

Revoke one by id — it stops authenticating immediately (idempotent, `204`):

```bash
curl -X DELETE https://tripplan.hups.club/me/api-tokens/3 -H "Authorization: Bearer $TOKEN"
```

Revoke a token the moment it's no longer needed or if it may have leaked. (A
token also stops working once past `expires_at`, or if the server's `JWT_SECRET`
is rotated — which invalidates *all* tokens and signs everyone out.)

---

## 3. Create flow

Building a trip is three kinds of POST, in order. Each returns the created row
including its `id`, which you feed into the next call:

```
POST /trips/                      → trip   (you become its owner)
POST /trips/{trip_id}/stops       → stop
POST /stops/{stop_id}/items       → itinerary item
```

### 3a. Create the trip — `POST /trips/`

| Field        | Type   | Required | Notes |
|--------------|--------|----------|-------|
| `name`       | string | yes      | |
| `start_date` | string | no       | ISO datetime, e.g. `2026-08-04T00:00:00` (or `2026-08-04`) |
| `end_date`   | string | no       | ISO datetime |
| `budget`     | string | no       | Cost-style string, e.g. `"5000 AUD"` |

Returns `201` with `{ "id": 42, "name": ..., "start_date": ..., "end_date": ...,
"budget": ..., "created_at": ..., "role": "owner" }`. Creating a trip
automatically makes you its **owner**, so you can add stops and items to it.

### 3b. Add a stop — `POST /trips/{trip_id}/stops`

| Field        | Type   | Required | Notes |
|--------------|--------|----------|-------|
| `location`   | string | yes      | e.g. `"Paris"` |
| `country`    | string | no       | |
| `arrive`     | string | no       | ISO datetime, **local wall-clock, no timezone suffix** (see §4) |
| `depart`     | string | no       | ISO datetime, local wall-clock |
| `timezone`   | string | no       | UTC offset as a string, e.g. `"2"` for UTC+2; default `"0"` |
| `lat`, `lng` | string | no       | Coordinates as strings |
| `sort_order` | int    | no       | Manual ordering hint; stops are otherwise ordered by date |
| `status`     | enum   | no       | `planned` (default) · `confirmed` · `completed` · `cancelled` |

Returns `201` with the stop including its `id`.

### 3c. Add an itinerary item — `POST /stops/{stop_id}/items`

| Field          | Type   | Required | Notes |
|----------------|--------|----------|-------|
| `kind`         | enum   | yes      | see list below (default `activity`) |
| `name`         | string | yes      | |
| `scheduled_at` | string | no       | ISO datetime, local wall-clock |
| `link`         | string | no       | URL |
| `cost`         | string | no       | Cost-style string, e.g. `"50 EUR"` |
| `notes`        | string | no       | Free-text notes shown on the item |
| `status`       | enum   | no       | `pending` (default) · `done` · `skipped` |
| `details`      | object | no       | Free-form per-kind JSON, see below |

`kind` is one of: `activity`, `restaurant`, `note`, `accommodation`, `flight`,
`rail`, `walk`, `cycling`, `transfer`, `river_transfer`, `tour`, `food`,
`purchase`, `show`, `hire`.

Returns `201` with the item including its `id`.

#### `details` conventions per kind

`details` is an untyped JSON object; the UI reads well-known keys. The common
ones (all datetimes are local wall-clock strings, `YYYY-MM-DDTHH:MM`):

| Kind            | Useful `details` keys |
|-----------------|-----------------------|
| `flight`        | `origin`, `destination` (IATA codes), `flight_number`, `airline`, `depart_time`, `arrive_time`, `depart_terminal`, `arrive_terminal`, `booking_ref` |
| `rail`          | `origin`, `destination`, `train_number`, `operator`, `depart_time`, `arrive_time`, `booking_ref` |
| `accommodation` | `location`, `checkin`, `checkout`, `booking_ref`, `contact_phone`, `contact_email`, `description` |
| `transfer` / `river_transfer` | `start_location`, `end_location`, `depart_time`, `arrive_time`, `duration`, `distance`, `provider`, `booking_ref` |
| others          | free-form; `description`, `notes` are commonly shown |

An item's timeline position comes from a kind-specific date: `depart_time` for
flight/rail, `checkin` for accommodation, otherwise `scheduled_at`. Set the
relevant one so the item sorts correctly.

---

## 4. Dates & timezones — which clock

Stop `arrive`/`depart` and item times (`depart_time`, `checkin`, `scheduled_at`,
…) are **local wall-clock** — the time on the clock where the event happens,
with **no timezone suffix**. Write `2026-08-04T15:00`, not
`2026-08-04T13:00Z`. A stop's `timezone` (UTC-offset string) is stored
alongside so notification scheduling can convert to UTC when needed. Don't send
`Z`-suffixed / offset-aware datetimes for these fields.

Trip `start_date`/`end_date` are treated as plain days; `T00:00:00` is fine.

---

## 5. Worked example

### curl

```bash
BASE=https://tripplan.hups.club
AUTH="Authorization: Bearer $TOKEN"
JSON="Content-Type: application/json"

# 1. Trip
trip_id=$(curl -s -X POST "$BASE/trips/" -H "$AUTH" -H "$JSON" \
  -d '{"name":"Summer in France","start_date":"2026-08-04","end_date":"2026-08-11"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 2. Stop
stop_id=$(curl -s -X POST "$BASE/trips/$trip_id/stops" -H "$AUTH" -H "$JSON" \
  -d '{"location":"Paris","country":"France","arrive":"2026-08-04T00:00:00","depart":"2026-08-07T00:00:00","timezone":"2"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 3. Items
curl -s -X POST "$BASE/stops/$stop_id/items" -H "$AUTH" -H "$JSON" \
  -d '{"kind":"accommodation","name":"Hotel Lutetia",
       "details":{"checkin":"2026-08-04T15:00","checkout":"2026-08-07T11:00","location":"45 Bd Raspail, Paris"}}'

curl -s -X POST "$BASE/stops/$stop_id/items" -H "$AUTH" -H "$JSON" \
  -d '{"kind":"activity","name":"Louvre","scheduled_at":"2026-08-05T10:00","cost":"22 EUR"}'
```

### Python

```python
import requests

BASE = "https://tripplan.hups.club"
H = {"Authorization": f"Bearer {TOKEN}"}

trip = requests.post(f"{BASE}/trips/", headers=H, json={
    "name": "Summer in France",
    "start_date": "2026-08-04", "end_date": "2026-08-11",
}).json()

stop = requests.post(f"{BASE}/trips/{trip['id']}/stops", headers=H, json={
    "location": "Paris", "country": "France",
    "arrive": "2026-08-04T00:00:00", "depart": "2026-08-07T00:00:00",
    "timezone": "2",
}).json()

requests.post(f"{BASE}/stops/{stop['id']}/items", headers=H, json={
    "kind": "accommodation", "name": "Hotel Lutetia",
    "details": {"checkin": "2026-08-04T15:00", "checkout": "2026-08-07T11:00"},
})
```

### From a Claude (or other agent) session

Give the agent the base URL and the PAT, and it can drive the same three calls.
A reliable prompt shape:

> Using `POST /trips/`, then `POST /trips/{id}/stops`, then
> `POST /stops/{id}/items` at `https://tripplan.hups.club` with
> `Authorization: Bearer <PAT>`, create a trip named "…" with these stops and
> items: … . Send local wall-clock datetimes with no timezone suffix. Report
> the created trip id.

---

## 6. Reschedule stops

`POST /trips/{trip_id}/reschedule` moves, creates and deletes a trip's stops
in one atomic request — and, for any moved stop, shifts every date-bearing
field of every item inside it by the same number of whole days (a stop
dragged 4 days later takes its flights, hotel check-in/out, and activities 4
days later too; time-of-day is always preserved exactly). Requires editor
access.

```bash
curl -s -X POST "$BASE/trips/$trip_id/reschedule" -H "$AUTH" -H "$JSON" -d '{
  "moves": [
    {"stop_id": 12, "arrive": "2026-10-04T00:00", "depart": "2026-10-07T00:00"}
  ],
  "creates": [
    {"location": "Hakone", "country": "JP", "arrive": "2026-10-05T00:00",
     "depart": "2026-10-06T00:00", "timezone": "GMT+9", "client_ref": "tmp-1"}
  ],
  "deletes": [15]
}'
```

- `moves[].arrive`/`depart` are the **full new values** for the stop (either
  may be `null` to clear), not a partial patch — same local wall-clock, no-
  timezone convention as everywhere else (§4). The shift applied to that
  stop's items is `new_arrive.date() - old_arrive.date()` (falling back to
  `depart` when a stop has no `arrive`, and to a no-op when it has neither).
- `moves[].base` is optional compare-and-set: `{"arrive": ..., "depart":
  ...}` as your script last saw them. If the server's current value has since
  changed and doesn't match, the whole request is rejected with `409` and
  **nothing is applied** — no stop in the batch is moved, not just the
  conflicting one.
- `creates[]` take the same fields as `POST /trips/{trip_id}/stops` (§3b)
  plus an optional `client_ref` string, echoed back in the response's
  `created` list as `{"client_ref": ..., "id": <new stop id>}` so you can map
  your own temporary ids to the real ones.
- `deletes[]` are stop ids to delete (same cascade as `DELETE /stops/{id}`:
  attachments removed, expenses unlinked not deleted). A stop id can't
  appear in both `moves` and `deletes` (`422`), and any id not belonging to
  `trip_id` is a `404`.
- An empty body (`{}`) is a no-op — `200` with the trip's stops unchanged.

Response:

```json
{
  "stops": [ "...every stop in the trip, in timeline order..." ],
  "created": [{"client_ref": "tmp-1", "id": 31}],
  "shifted_items": [{"item_id": 88, "stop_id": 12, "delta_days": 4}],
  "inverse": {"moves": [...], "creates": [], "deletes": [31]},
  "undo_lossy": false
}
```

`inverse` is a request body that undoes this call — `POST` it straight back
to this same endpoint to revert. `undo_lossy` is `true` whenever this call's
`deletes` was non-empty: a deleted stop's items are gone, so undoing a delete
can't be expressed as a create, and `inverse.creates` is always `[]`.

---

## 7. Travelers

`Traveler` rows record who is *physically going* on a trip — separate from
`TripMembership` (who may view/edit it, §2-§6). A traveler may have no
account at all (a child, a partner who doesn't use the app); a member may
not be traveling. Creating a trip does **not** auto-add you as a traveler —
`POST` yourself explicitly if you're going.

```
GET    /trips/{trip_id}/travelers                     → list (clear fields only)
POST   /trips/{trip_id}/travelers                      → create
PATCH  /trips/{trip_id}/travelers/{id}                 → update display_name / user_email
DELETE /trips/{trip_id}/travelers/{id}                 → 204
GET    /trips/{trip_id}/travelers/{id}/profile         → decrypt-on-demand booking profile
PUT    /trips/{trip_id}/travelers/{id}/profile         → merge-update the booking profile
DELETE /trips/{trip_id}/travelers/{id}/profile         → clear the profile (keeps the traveler row)
```

### Permission matrix

| actor | list | read profile | create | update | delete |
|---|---|---|---|---|---|
| owner | any | any traveler | any | any | any |
| editor | any | **own** entry only | own only (`user_email` forced to self) | own only | own only |
| viewer | any | own entry only | ✗ (`403`) | ✗ (`403`) | ✗ (`403`) |
| no access to the trip | `404` | | | | |

"Own entry" = the traveler row whose `user_email` matches your token's
identity. Only the trip **owner** may set or change a row's `user_email`
(linking a traveler to a different account) — an editor's create/update is
silently forced to their own email. A profile read that's neither yours nor
owner-accessed is `403` (the row is already visible in the list, so `404`
would be a lie); a traveler id belonging to a different trip is `404` on
every route.

### Clear vs. encrypted fields

`GET`/list responses only ever include the clear columns: `id`, `trip_id`,
`user_email`, `display_name`, `age_band` (`infant`/`child`/`adult`, derived),
`passport_expiry`, `has_profile` (bool), `created_at`, `updated_at`.
Everything booking-relevant lives in the encrypted profile, decrypted only by
`GET`/`PUT .../profile`: `full_name`, `date_of_birth` (`YYYY-MM-DD`), `sex`,
`nationality`, `passport_number`, `passport_issuing_country`, `email`,
`phone`, `frequent_flyer` (`[{airline, number}]`), `meal_preference`,
`seat_preference`, `notes` — plus `passport_expiry` (accepted/returned here
too since it's part of the same passport form, but actually stored in the
clear column above) and the derived, never-stored `age_at_trip_start`
(computed against the trip's `start_date`, or today if the trip is undated).

**Any route that touches the encrypted profile (`PUT`/`GET .../profile`)
returns `503` if the server has no `DOCUMENT_ENCRYPTION_KEY` configured** —
the same key (and requirement) as the document vault. List/create/patch/
delete never need the key and work regardless.

```bash
# Create a traveler, then fill in their passport details.
traveler_id=$(curl -s -X POST "$BASE/trips/$trip_id/travelers" -H "$AUTH" -H "$JSON" \
  -d '{"display_name": "Jamie Smith"}' | jq -r .id)

curl -s -X PUT "$BASE/trips/$trip_id/travelers/$traveler_id/profile" -H "$AUTH" -H "$JSON" -d '{
  "full_name": "JAMIE ANN SMITH", "date_of_birth": "1990-04-02",
  "nationality": "AUS", "passport_number": "PA1234567",
  "passport_issuing_country": "AUS", "passport_expiry": "2030-04-02T00:00:00"
}'
```

A passport expiring less than 6 months after the trip's last day (a common
entry rule) surfaces as a `passport_expiry` warning in the existing
`GET /trips/{trip_id}/date-warnings` endpoint — no separate polling needed.

---

## 8. Notes & caveats

- **No idempotency.** Re-running the same POSTs creates duplicate rows. If a run
  might be retried, capture the returned `id`s and don't blindly re-POST.
- **Errors.** Standard HTTP: `401` (missing/invalid/expired/revoked token),
  `422` (validation error — the body names the offending field). Permission
  errors on a trip/stop/item are `404` if you have **no** access to that trip at
  all (deliberately indistinguishable from the trip not existing, so a probe
  can't learn it exists) — `403` only if you have **some** role on it but below
  what the call needs (e.g. a viewer hitting a create endpoint, which needs
  editor).
- **One request at a time is fine.** There's no bulk/composite create endpoint
  today; if orchestrating many items becomes painful, a `POST /trips/import`
  that accepts a whole trip in one call would be a natural addition — not built
  yet.
- **Token lifetime** is set by `API_TOKEN_EXPIRE_DAYS` on the server (default
  365). Mint a new token before the old one expires; there's no auto-refresh for
  PATs.
