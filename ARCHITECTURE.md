# Travel Companion — Architecture & Reference

> Snapshot for re-loading context in future sessions. Last updated: 2026-06-28.

## Overview

A personal travel itinerary web app. A FastAPI + SQLite backend serves a REST API
**and** the compiled React SPA from the same origin. Users organise **Trips →
Stops → Itinerary Items**, with rich per-kind detail (flights, rail, hotels,
activities, etc.), multi-currency cost tracking, Google Sheets import, and
email ingestion of booking confirmations (parsed by Claude).

- **Repo:** `https://github.com/hamBank/travelCompantion.git` (default branch `main`)
- **Local root:** `F:\Users\foobi\Downloads\travelApp\backend\travelCompantion\`
- **Production:** `https://tripplan.hups.club` on server `camelidcastle.hups.club`

## Stack

- **Backend:** FastAPI + SQLModel (SQLAlchemy) + SQLite (`travel.db`)
- **Frontend:** React + Vite + Tailwind, built into `backend/static/`
- **Auth:** Google OAuth (JWT bearer tokens); auth can be disabled for local dev
- **Server:** systemd unit `travelcomp` runs uvicorn on `127.0.0.1:8000`, behind
  Apache vhost (`tripplan.hups.club.conf`). Debian/Ubuntu.

## Repo layout

```
backend/
  main.py            # FastAPI app, auth middleware, static mount, /deploy, /health, /currency/convert
  database.py        # SQLite engine + startup migrations
  models.py          # SQLModel tables + Pydantic schemas (see Data Model)
  auth.py            # JWT + Google token verification, AUTH_ENABLED flag
  importer.py        # Google Sheets CSV → DB seeding
  sheets.py          # Google Sheets OAuth fetch
  documents.py       # Claude-based email/document parsing → PendingChange builder
  permissions.py     # require_trip_role / require_stop_role / require_item_role
  routers/
    trips.py         # /trips CRUD + /trips/{id}/timeline
    stops.py         # /trips/{id}/stops, /stops/{id} CRUD + reorder
    items.py         # /items CRUD, enrich, flight/rail check, gpx, geocode, route-elevation
    sheets_import.py # /import/* endpoints
    auth_router.py   # /auth/google, /auth/me, /auth/config
    ingest.py        # POST /ingest/email — receives raw .eml from postfix pipe
    pending.py       # GET/PATCH /pending, POST /pending/{id}/apply|discard
    me.py            # GET /me/import-address — stable per-user email forwarding address
  static/            # COMPILED frontend output (committed) — served at /
mail_ingest.py                   # stdlib-only stdin→POST shim (run by postfix pipe)
scripts/
  mail_ingest_wrapper.sh         # sources .env, execs mail_ingest.py; run as travelcomp user
frontend/
  src/
    App.jsx                  # Shell: auth gate, header, theme, settings gear,
                             #   📥 Imports badge (60s poll), PendingReview modal trigger
    api.js                   # fetch wrapper + all endpoint helpers
    kinds.js                 # SINGLE SOURCE OF TRUTH for item kinds (see below)
    currency.js              # cost parsing, conversion, formatting, isFullyPaid
    settings.js              # reactive hide-completed store (useSyncExternalStore)
    powerbank.js             # airline power bank policy lookup (hand-maintained)
    themes.js, countryFlag.js, airportNames.js
    index.css                # Tailwind + CSS variables per theme (5 themes)
    components/
      TripList, TripTimeline, StopCard, EditTrip, EditStopCard, EditItemsSection
      ItemRow                # generic/activity/note row with status cycle
      ItemEditModal          # kind-specific edit forms + Payment section + Delete
      ItemDetailModal        # read-only detail (accom/activity/restaurant/note/cycling)
      FlightDetailModal, RailDetailModal   # kind-specific detail views
      DetailActions          # shared Edit + Delete footer (inline confirm)
      CostDisplay            # cost + converted + paid/outstanding breakdown
      UserSettings           # currency picker + hide-completed toggle +
                             #   ImportAddress ("Forward bookings by email")
      PendingReview          # modal: review/apply/discard email-ingested items
      ThemePicker, LoginPage, ShareModal
```

## Data Model (`backend/models.py`)

Hierarchy: **Trip** 1─∞ **Stop** 1─∞ **ItineraryItem**.

### Trip
`id, name, start_date?, end_date?, created_at`

### Stop
`id, trip_id, location, country, arrive?, depart?, timezone="0", lat, lng,
sort_order, status`
- `status ∈ StopStatus = {planned, confirmed, completed, cancelled}`
- Legacy columns (`accommodation*`, `check_in/out`) kept for the startup migration
  that converts old accommodation fields into ItineraryItems.

### ItineraryItem
`id, stop_id, kind, name, scheduled_at?, link, cost, notes, status, details(JSON)`
- `status ∈ ItemStatus = {pending, done, skipped}`
- `kind ∈ ItemKind = {activity, restaurant, note, accommodation, flight, cycling,
  rail, walk, transfer, tour, food, purchase}`
- **`details`** is a free-form JSON blob holding kind-specific fields. This is where
  most per-kind data lives. **When patching `details`, the backend calls
  `flag_modified(item, 'details')`** so SQLAlchemy detects the JSON change.

### PendingChange
`id, source, source_email_id?, trip_id?, suggested_stop_id?, op, payload(JSON),
diff(JSON)?, confidence, match_reason, status`
- Created by email ingestion and document upload; reviewed/applied by the user
- `source ∈ {upload, email}`; `source_email_id` FK → `IngestedEmail`
- `op ∈ {create, update}`; `status ∈ {pending, applied, discarded}`
- `payload` is the parsed item fields; `diff` is before→after for `op=update`

### IngestedEmail
`id, received_at, from_addr, to_addr, subject, storage_dir, resolved_user_email,
status, parse_error?, item_count`
- `status ∈ {received, parsed, error}`
- `storage_dir` → `mail_store/<uuid>/` containing `raw.eml` + numbered attachments
- `status=received` when `ANTHROPIC_API_KEY` is absent (stored but not parsed)

### UserImportToken
`user_email (PK), token (indexed), created_at`
- One row per user; generated on first call to `GET /me/import-address`
- Token appears as the `+extension` in `import+<token>@<MAIL_DOMAIN>`
- Rotation: delete the row (a new token is issued on next Settings view).
  No in-app rotation UI exists yet.

#### Notable `details` keys by kind
- **All (with cost):** `amount_paid`, `converted_cost`, `converted_amount_paid`,
  `converted_currency` (written at save time by ItemEditModal — see Currency)
- **accommodation:** `location, checkin, checkout, booking_ref, contact_phone,
  contact_email, website, description, amount_paid`
- **flight:** `origin, destination, flight_number, airline, depart_time, arrive_time,
  depart_tz, arrive_tz, duration, origin_terminal, origin_gate, arrive_terminal,
  arrive_gate, checkin_desk, fare_class, seats, booking_ref, …`
- **rail:** `origin, destination, train_number, operator, depart_time, arrive_time,
  depart_platform, arrive_platform, rail_class, seats, booking_ref, …`
- **restaurant:** `location, reservation_time, booking_status, booking_ref, contact_phone`
- **walk/cycling:** `start_location, end_location, distance, elevation_gain,
  elevation_loss, duration, difficulty, surface_type, maps_url, gpx_filename,
  original_gpx_name`, walk also `description`
- **transfer:** `start_location, end_location, vehicle_type, distance, duration,
  provider, booking_ref, maps_url`
- **tour:** `tour_type, meeting_point, duration, operator, booking_ref, cost_per_person`
- **food:** `description`
- **purchase:** `description, location`

## Item kinds — single source of truth

`frontend/src/kinds.js` exports `KIND_VAR` (colour CSS var), `KIND_LABEL` (display
name), `KIND_OPTIONS` (ordered list). **Adding a new kind = edit `kinds.js` +
`ItemKind` enum in `models.py` + add a `--kind-<name>` colour to each theme in
`index.css` + add a form to `ItemEditModal` + a card to `StopCard`.**

## Currency & cost tracking

- Free-text `cost` strings (e.g. `€450`, `฿1,500`, `USD 120`) are parsed by
  `parseCost()` in `currency.js`.
- A **home currency** preference (Settings) is stored in `localStorage` as
  `tc-home-currency`.
- On item save, if cost/amount_paid changed (or no conversion stored yet),
  ItemEditModal calls **`GET /currency/convert`** (backend proxy to
  `open.er-api.com`) and stores `converted_cost` / `converted_amount_paid` in
  `details`. Conversion is NOT done on render.
- `CostDisplay` shows original cost + `(converted)` in muted text, and a
  Total/Paid/Outstanding breakdown when `amount_paid` is set. `formatCurrencyAmount`
  disambiguates symbols (e.g. A$ vs US$). `isFullyPaid()` drives hiding cost on
  collapsed cards once paid ≥ cost.
- **Backend currency endpoint** uses stdlib `urllib` in a thread executor (NOT
  httpx) — Frankfurter was blocked by Cloudflare 403, so switched to
  `open.er-api.com`.

## Completion & display prefs

- Clicking a card's kind icon toggles item `status` done↔pending (`CardIcon` in
  StopCard, optimistic + rollback).
- `settings.js` holds a reactive **hide-completed** flag (`tc-hide-completed`) via
  `useSyncExternalStore`; StopCard filters done items when enabled. Toggle lives in
  UserSettings → Display.

## Auth & permissions

See **PERMISSIONS.md** for the full role/sharing design. In brief: per-trip roles
(viewer < editor < owner) via the `TripMembership` table, keyed by email.
`backend/permissions.py` enforces every endpoint; `frontend/src/roles.js`
(`RoleContext`) gates UI. Sharing via owner-only `ShareModal` + `/trips/{id}/members`.

- `auth.py` `AUTH_ENABLED` (env). When disabled, middleware passes through, the
  frontend auto-logs-in as a dev user, and all permission checks return `owner`.
- When enabled: middleware validates `Authorization: Bearer <JWT>` except for
  public prefixes: `/auth/`, `/health`, `/currency/`, `/assets/`, `/sw.`,
  `/registerSW.`, `/manifest.`, **`/ingest/`** and exact public paths (`/`,
  `/index.html`, static icons, `/privacy.html`, `/tos.html`, `/deploy`).
  `/ingest/` uses its own shared-secret auth (`X-Ingest-Secret` header) and must
  stay localhost-only — Apache never proxies it.
- Google OAuth client id served via `/auth/config`; login posts credential to
  `/auth/google`, returns JWT stored in `localStorage` as `tc-token`.

## Key API endpoints

```
Trips:   GET/POST /trips/ ; GET/PATCH/DELETE /trips/{id} ; GET /trips/{id}/timeline
Stops:   GET/POST /trips/{id}/stops ; GET/PATCH/DELETE /stops/{id} ; PATCH /stops/{id}/reorder
Items:   GET/POST /stops/{id}/items ; GET/PATCH/DELETE /items/{id}
         GET /items/{id}/enrich          (Google Places autofill)
         GET /items/{id}/flight-check    (AviationStack)
         GET /items/{id}/rail-check
         POST/GET /items/{id}/gpx        (upload / download GPX)
         GET /flights/airline-lookup?iata=
         GET /geocode?q= ; GET /route-elevation?lat1=&lng1=&lat2=&lng2=
Import:  POST /import/sheets ; /import/sheets/flights/{trip_id} ; …backfill endpoints
Auth:    POST /auth/google ; GET /auth/me ; GET /auth/config
Me:      GET /me/import-address          (generate/return stable email forwarding address)
Ingest:  POST /ingest/email              (localhost-only; secret-auth; called by postfix pipe)
Pending: GET /pending[?trip_id=N]        (list PendingChanges, includes null-trip rows)
         PATCH /pending/{id}             (edit trip/stop/kind/payload)
         POST /pending/{id}/apply        (create or update item; enforces trip role)
         POST /pending/{id}/discard      (204)
System:  POST /deploy (GitHub webhook, HMAC) ; GET /health ; GET /currency/convert
```

External services: Google Places (`GOOGLE_PLACES_API_KEY`), AviationStack
(`AVIATIONSTACK_KEY`), open.er-api.com (currency, no key), OpenStreetMap tiles +
OpenTopoData (GPX map/elevation, client-side), Google Sheets OAuth,
Anthropic Claude API (`ANTHROPIC_API_KEY`, email parsing).

## Email ingestion

Users forward booking confirmation emails to a personal address
(`import+<token>@<MAIL_DOMAIN>`). Postfix pipes the raw message to
`scripts/mail_ingest_wrapper.sh`, which calls `mail_ingest.py` (stdlib-only
stdin→POST shim). The shim POSTs the raw `.eml` to `POST /ingest/email`
(localhost only) with `X-Ingest-Secret` + `X-Original-To` headers.

The endpoint:
1. Authenticates via the shared secret (`MAIL_INGEST_SECRET` env var).
2. Extracts the `+token` from the recipient address and looks up `UserImportToken`.
3. Stores `raw.eml` + attachments in `mail_store/<uuid>/` and creates an
   `IngestedEmail` row.
4. If `ANTHROPIC_API_KEY` is set, calls `documents.py` → Claude → creates
   `PendingChange` rows (one per extracted item, `source="email"`).
5. Returns `202 {id, resolved, items}` (pipe exits 0; on failure exits 75 so
   postfix retries).

Frontend flow:
- **Settings → "Forward bookings by email"** (`ImportAddress` component in
  `UserSettings`) shows the stable forwarding address with a Copy button.
- `App.jsx` polls `GET /pending` every 60 seconds; when `pendingCount > 0` a
  `📥 Imports (N)` footer badge appears.
- Clicking the badge opens `PendingReview` modal: trip/stop/kind selectors,
  parsed fields, confidence score, and Apply / Discard buttons.
- `TripTimeline` also shows a per-trip "Review pending" button.

Env vars: `MAIL_INGEST_SECRET`, `MAIL_DOMAIN` (default `tripplan.hups.club`),
`MAIL_STORE_DIR` (default `/opt/travelcomp/mail_store`), `ANTHROPIC_API_KEY`.

See `docs/email-ingestion.md` for the full Postfix/DNS setup runbook.

**Known gaps (not yet implemented):**
- No `DELETE /me/import-token` endpoint or in-app "Regenerate address" button —
  token rotation requires a manual DB delete.
- `PendingReview` does not display the `source` field or link back to the
  originating email — the data is captured in `PendingChange.source_email_id`
  but the UI does not surface it yet.

## Build & deploy workflow

```bash
# Frontend build (required after any frontend/src change) — outputs to backend/static/
cd F:\Users\foobi\Downloads\travelApp\backend\travelCompantion\frontend
npm run build

# Run backend locally
cd F:\Users\foobi\Downloads\travelApp\backend\travelCompantion
python -m uvicorn backend.main:app --reload   # → http://localhost:8000
```

**Git workflow used in this project:** make changes → build frontend if any
`frontend/src` changed → commit BOTH source and built `backend/static/` assets →
create a branch, push, merge to `main`, push `main`. Push via HTTPS with PAT
(credentials in project memory, not in repo).

**Production deploy:** `deploy.sh` (idempotent) provisions packages, the
`travelcomp` system user, `/opt/travelcomp`, the systemd service, and Apache vhost.
A push to `main` can trigger redeploy via the `/deploy` webhook (HMAC-signed,
`DEPLOY_SECRET`) which touches `.deploy-trigger`; a systemd path unit runs
`deploy.sh --update`. Deploy logs: `/var/log/travelcomp-deploy.log` (each run
writes a timestamped header).

## Server access

SSH: `ssh -i C:/Users/foobi/.ssh/travelcomp_id anto@camelidcastle.hups.club`
- App dir `/opt/travelcomp`, service `travelcomp`, deploy log
  `/var/log/travelcomp-deploy.log`.

## Scheduled maintenance

- `powerbank-policy-refresh` scheduled task (Claude routine): monthly on the 20th,
  refreshes `frontend/src/powerbank.js` against current airline rules. Intended to
  run only July & August 2026 — delete after the August run.
- Power bank data reflects the **ICAO global standard effective 27 Mar 2026** (max 2
  power banks, cabin-only, no in-flight use/charging).

## Conventions / gotchas

- `SPEC.md` holds the original product spec + data model reference (note: predates
  email ingestion — `PendingChange`, `IngestedEmail`, `UserImportToken`, and the
  ingest/pending/me routers are not reflected there).
- The compiled `backend/static/` bundle is committed — always rebuild before commit.
- JSON `details` edits need `flag_modified` server-side (already handled in
  `routers/items.py`).
- Tests: `tests/` (pytest backend), `frontend/src/*.test.{js,jsx}` (vitest).
