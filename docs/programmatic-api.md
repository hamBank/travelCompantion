# Programmatic API — creating trips without the browser

This describes how to create trips (and their stops and itinerary items) over
HTTP from a script, a scheduled job, or an AI agent (e.g. a Claude session),
using the app's existing REST endpoints. It covers the two things that aren't
obvious from the endpoints themselves: **authentication** and the **create
flow**.

Scope: **create only**. Updating and deleting are intentionally out of scope for
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
> paste it anywhere shared. It is stateless, so it can't be individually
> revoked — it simply expires (default one year). To revoke *all* tokens at
> once, rotate `JWT_SECRET` on the server (this also signs everyone out).

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
  -d '{"days": 365}'
```

Response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsIn...",
  "token_type": "bearer",
  "expires_at": "2027-08-20T09:00:00Z",
  "email": "you@example.com"
}
```

- `days` is optional and clamped to `[1, API_TOKEN_EXPIRE_DAYS]` (server default
  365). Omit the body entirely for the default lifetime.
- Store `token`; that's what every request below uses.

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

## 6. Notes & caveats

- **No idempotency.** Re-running the same POSTs creates duplicate rows. If a run
  might be retried, capture the returned `id`s and don't blindly re-POST.
- **Errors.** Standard HTTP: `401` (missing/invalid/expired token), `403`
  (authenticated but not permitted on that trip), `422` (validation error — the
  body names the offending field), `404` (no such trip/stop).
- **One request at a time is fine.** There's no bulk/composite create endpoint
  today; if orchestrating many items becomes painful, a `POST /trips/import`
  that accepts a whole trip in one call would be a natural addition — not built
  yet.
- **Token lifetime** is set by `API_TOKEN_EXPIRE_DAYS` on the server (default
  365). Mint a new token before the old one expires; there's no auto-refresh for
  PATs.
