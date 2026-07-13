# Travel Companion — Architecture & Reference

> Snapshot for re-loading context in future sessions. Last updated: 2026-07-13.
> For day-to-day conventions (test gates, build/push workflow, timezone rules,
> weather cache versioning) see **`CLAUDE.md`** at the repo root — this file
> covers the shape of the system, not the operating rules.

## Overview

A personal travel itinerary web app. A FastAPI backend serves a REST API **and**
the compiled React SPA from the same origin. Users organise **Trips → Stops →
Itinerary Items**, with rich per-kind detail (flights, rail, hotels, activities,
etc.), multi-currency cost tracking, Google Sheets import, and email/document
ingestion of booking confirmations (parsed by Claude). Beyond the core
itinerary, the app also covers: per-trip **packing lists** (nested bags, shared
vs. personal items), a **budget dashboard**, an encrypted **document vault**
(passport/licence/visa scans with local OCR extraction), per-trip **sharing**
with role-based permissions, an **offline-capable PWA** with a write queue, and
**push notifications** (check-in windows, flight delays, document expiry).

- **Repo:** `https://github.com/hamBank/travelCompantion.git` (default branch `main`)
- **Production:** `https://tripplan.hups.club` on server `camelidcastle.hups.club`

## Stack

- **Backend:** FastAPI + SQLModel (SQLAlchemy). **Postgres in production**
  (cut over 2026-06-30 — see `docs/postgres-migration.md`); SQLite
  (`travel.db`) for local dev and tests. `DATABASE_URL` selects the backend.
- **Schema:** Alembic owns the schema (`alembic/versions/`) — `backend/models.py`
  is the source of truth; every model change needs a migration (see CLAUDE.md).
  SQLite tests still use `create_all()` for speed; `test_alembic_drift.py`
  keeps that in sync with the migrations.
- **Frontend:** React + Vite + Tailwind, built into `backend/static/` (committed)
- **Auth:** Google OAuth (JWT bearer tokens); auth can be disabled for local dev
  (`AUTH_ENABLED=False` — every request treated as `owner`)
- **Server:** systemd unit `travelcomp` runs uvicorn behind an Apache vhost
  (`tripplan.hups.club.conf`). Debian/Ubuntu. Deploys auto-trigger on push to
  `main` via a webhook → `.deploy-trigger` path watcher → `deploy.sh --update`.

## Repo layout

```
backend/
  main.py            # FastAPI app, auth middleware, static mount, /deploy, /health
  database.py        # engine + startup migrations/backfills (SQLite self-migrates;
                     #   Postgres schema is Alembic-owned)
  models.py          # SQLModel tables + Pydantic schemas — see Data Model
  auth.py            # JWT + Google token verification, AUTH_ENABLED flag
  permissions.py     # require_trip_role / require_stop_role / require_item_role
  importer.py        # Google Sheets CSV → DB seeding
  sheets.py          # Google Sheets OAuth fetch
  documents.py       # Claude-based email/document parsing → PendingChange builder
  passport_ocr.py    # Local, offline passport MRZ OCR (Tesseract + `mrz` package,
                     #   no network call) — see docs/plans/plan-13-passport-ocr.md
  document_crypto.py # Fernet encryption for the document vault's sensitive fields
  weather.py         # Open-Meteo lookups + WeatherCache — CACHE_VERSION bump
                     #   convention documented in CLAUDE.md
  flight_live.py     # AeroDataBox flight-by-number fetch + delay_min/delay_str —
                     #   shared by items.py's flight-check and notifications.py's
                     #   live delay/cancel/gate-change alerts (no circular import)
  notifications.py  # push triggers: check-in window, departure lead time, document
                     #   expiry, and (send_flight_alerts) live-polled delay/cancel/
                     #   gate alerts
  tzutil.py          # shared longitude→approx-UTC-offset helper (see CLAUDE.md's
                     #   "Timezone handling" section — several distinct clocks)
  compare_and_set.py # offline-queue conflict resolution (plan-11)
  routers/
    trips.py         # /trips CRUD + /trips/{id}/timeline
    stops.py         # /trips/{id}/stops, /stops/{id} CRUD + reorder
    items.py         # /items CRUD, enrich, flight/rail check, gpx, geocode, route-elevation
    attachments.py   # /items/{id}/attachments — boarding passes, booking PDFs, QR codes
    calendar.py      # ICS calendar feed
    packing.py       # /trips/{id}/packing (bags + personal/shared items)
    vault.py         # /me/documents (+ files, scan, holder data) — the document vault
    weather.py       # /stops/{id}/weather (or similar) — cached Open-Meteo lookups
    push.py          # Web Push subscribe/unsubscribe
    sheets_import.py # /import/* endpoints
    auth_router.py   # /auth/google, /auth/me, /auth/config
    ingest.py        # POST /ingest/email — receives raw .eml from postfix pipe
    pending.py       # GET/PATCH /pending, POST /pending/{id}/apply|discard
    me.py            # GET /me/import-address — stable per-user email forwarding address
    shared.py        # public (no-login) share-link view of a trip
  static/            # COMPILED frontend output (committed) — served at /
mail_ingest.py                   # stdlib-only stdin→POST shim (run by postfix pipe)
scripts/
  send_notifications.py         # cron entry point: send_due_notifications +
                                 #   send_flight_alerts (skipped if AERODATABOX_KEY unset)
  refresh_weather.py             # nightly cron: pre-warms WeatherCache, shares the
                                 #   is_degraded() guard with the live endpoint
  mail_ingest_wrapper.sh         # sources .env, execs mail_ingest.py; run as travelcomp user
  smoke_check.sh                 # post-deploy sanity check on the server
alembic/versions/                # schema migrations (see "Schema" above)
frontend/
  src/
    App.jsx                  # Shell: auth gate; header with a sticky-positioned,
                             #   safe-area-aware bar and a hamburger MenuDropdown
                             #   (Edit/View, Packing/Timeline, Share, Export PDF,
                             #   Budget, Imports, Documents, Settings, theme picker,
                             #   Sign out); footer keeps only what's used every
                             #   session (Today/All-days toggle, kind filter — or,
                             #   while in Packing view, a "hide packed" filter in
                             #   the same slot — Import from document, Add item)
    api.js                   # fetch wrapper + all endpoint helpers
    kinds.js                 # SINGLE SOURCE OF TRUTH for item kinds (see below)
    currency.js, budget.js   # cost parsing, conversion, formatting, budget rollups
    settings.js              # reactive display-prefs store (useSyncExternalStore)
    roles.js                 # RoleContext, useCanEdit()/useCanManage() (permissions)
    online.js, offlineQueue.js, compare_and_set-equivalent client logic,
    vaultOfflineStore.js      # IndexedDB cache for offline-viewable vault files
    push.js                  # Web Push subscribe/unsubscribe client helpers
    tzutil.js                 # frontend counterpart to backend/tzutil.py
    powerbank.js             # airline power bank policy lookup (hand-maintained)
    themes.js, countryFlag.js, countryFacts.js, airportNames.js, seatguru.js
    index.css                # Tailwind + CSS variables per theme, iOS safe-area rules
    components/
      TripList, TripTimeline, StopCard, EditTrip, EditStopCard, EditItemsSection
      ItemRow                # generic/activity/note row with status cycle
      ItemEditModal          # kind-specific edit forms + Payment section + Delete
      ItemDetailModal        # read-only detail (accom/activity/restaurant/note/cycling)
      ItemHistoryModal        # per-item audit log (create/update/delete history)
      FlightDetailModal, RailDetailModal, RailLookupModal   # kind-specific detail/lookup
      DetailActions          # shared Edit + Delete footer (inline confirm)
      CostDisplay            # cost + converted + paid/outstanding breakdown
      BudgetSummary          # per-trip budget vs. spend rollup modal
      PackingList, BagEditModal, PackItemEditModal   # packing list (nested bags,
                             #   personal/shared items, per-bag "packed" flag)
      DocumentsModal         # the document vault's own modal (its own hamburger
                             #   menu entry — split out of UserSettings)
      DocumentImportModal, DocumentViewer
      UserSettings           # currency picker, display prefs, notifications,
                             #   ImportAddress ("Forward bookings by email")
      MenuDropdown           # generic trigger+dropdown-panel wrapper (outside-click/
                             #   Escape to close) backing the header's hamburger menu
      Toggle                 # shared switch control (UserSettings + DocumentsModal)
      PendingReview          # modal: review/apply/discard email/document-ingested items
      ThemePicker, LoginPage, ShareModal, SharedTripView
      OfflineQueueBanner      # surfaces queued offline writes + conflicts
```

## Data Model (`backend/models.py`)

Core hierarchy: **Trip** 1─∞ **Stop** 1─∞ **ItineraryItem**. Everything else
(packing, vault documents, budget) hangs off `Trip` or the user directly.

### Trip
`id, name, start_date?, end_date?, budget?, share_token?, created_at`

### TripMembership
`id, trip_id, user_email (lowercased), role (viewer|editor|owner), created_at`
— one row per user-per-trip. See **PERMISSIONS.md** for the full role model.

### Stop
`id, trip_id, location, country, arrive?, depart?, timezone="0", lat, lng,
sort_order, status`
- `status ∈ StopStatus = {planned, confirmed, completed, cancelled}`

### ItineraryItem
`id, stop_id, kind, name, scheduled_at?, link, cost, notes, status, details(JSON)`
- `status ∈ ItemStatus = {pending, done, skipped}`
- `kind ∈ ItemKind = {activity, restaurant, note, accommodation, flight, cycling,
  rail, walk, transfer, tour, food, purchase, river_transfer, show, hire}`
- **`details`** is a free-form JSON blob holding kind-specific fields — see
  `frontend/src/kinds.js` and `ItemEditModal` for the current per-kind shape.
  **When patching `details`, the backend calls `flag_modified(item, 'details')`.**

### ItemAttachment / ItemHistory
- `ItemAttachment`: a file (boarding pass, booking PDF, QR code) blobbed
  directly in the DB against an item, for at-the-gate viewing even offline-ish.
- `ItemHistory`: append-only audit log of create/update/delete on an item
  (`item_id` deliberately not an FK, so history survives item deletion).

### PendingChange / IngestedEmail / ProcessedDocument
- `PendingChange`: proposed create/update from email or document ingestion,
  reviewed/applied by the user (`op ∈ {create, update}`, `status ∈ {pending,
  applied, discarded}`).
- `IngestedEmail`: one row per forwarded booking email (`mail_store/<uuid>/`
  holds the raw `.eml` + attachments).
- `ProcessedDocument`: hash-based cache so re-uploading the same file for the
  same trip skips the Claude parse call.

### UserImportToken
`user_email (PK), token, created_at` — the `+token` in a user's stable
`import+<token>@<MAIL_DOMAIN>` forwarding address.

### Bag / PackingItem (packing list)
- `Bag`: `id, trip_id, name, parent_id? (self-FK, nesting), packed, created_at`.
  Bags nest via `parent_id` (e.g. a packing cube inside a suitcase). `packed`
  is a **manual, independent** flag — marking a bag packed rolls its whole
  subtree up as fully packed in parent counts, regardless of the actual state
  of the items/sub-bags inside it.
- `PackingItem`: `id, trip_id, name, owner_email ("" = shared), bag_id?,
  quantity, packed_count, sort_order, created_at`. `packed_count`/`quantity`
  track partial packing (e.g. 3 of 5 socks).

### PushSubscription / NotificationLog
- `PushSubscription`: one row per browser/device Web Push subscription
  (`user_email, endpoint (unique), p256dh, auth, device_label`).
- `NotificationLog`: idempotency guard — `(item_id, kind)` marks a
  notification already sent so the periodic job never double-sends.

### WeatherCache
`cache_key ("lat,lng,start,end", coords rounded), payload(JSON), fetched_at`
— cache of Open-Meteo lookups. **`CACHE_VERSION`** in `backend/weather.py` must
be bumped whenever a change would make previously-cached payloads wrong (see
CLAUDE.md's "Weather cache — change checklist").

### UserDocument / UserDocumentFile (document vault)
- `UserDocument`: a user's own travel document (passport/licence/visa) —
  **never trip-scoped**, keyed on `user_email` directly (no `User` table).
  `document_number_encrypted` and `holder_data_encrypted` (holder name/
  nationality/DOB/sex, sourced from passport MRZ OCR or manual entry) are
  Fernet-encrypted blobs; everything else (`doc_type`, `label`, `country`,
  `expiry_date`) stays in the clear so it can be queried/rendered (e.g. by the
  expiry-reminder cron) without a decrypt round-trip.
- `UserDocumentFile`: one or more encrypted scans per document, same
  blob-in-DB shape as `ItemAttachment`.
- **Passport scan OCR** (`backend/passport_ocr.py`): fully local/offline —
  Tesseract + the `mrz` package parse and checksum-validate the MRZ, with a
  4-rung preprocessing ladder (raw → autocontrast → global-Otsu → local
  adaptive-mean threshold) plus checksum-guided selection across rungs, and
  an optional OCR-B-trained traineddata preference. See
  `docs/plans/plan-13-passport-ocr.md` for the full investigation history —
  it has accumulated several real-world-regression fix notes worth reading
  before touching this file.

## Item kinds — single source of truth

`frontend/src/kinds.js` exports `KIND_VAR` (colour CSS var), `KIND_LABEL` (display
name), `KIND_OPTIONS` (ordered list). **Adding a new kind = edit `kinds.js` +
`ItemKind` enum in `models.py` (+ an Alembic migration) + a `--kind-<name>`
colour to each theme in `index.css` + a form to `ItemEditModal` + a card to
`StopCard`.**

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
  Total/Paid/Outstanding breakdown when `amount_paid` is set.
- `BudgetSummary` rolls per-trip spend up against `Trip.budget` (`budget.js`).
- **Backend currency endpoint** uses stdlib `urllib` in a thread executor (NOT
  httpx) — Frankfurter was blocked by Cloudflare 403, so switched to
  `open.er-api.com`.

## Auth & permissions

See **PERMISSIONS.md** for the full role/sharing design. In brief: per-trip roles
(viewer < editor < owner) via the `TripMembership` table, keyed by email.
`backend/permissions.py` enforces every endpoint; `frontend/src/roles.js`
(`RoleContext`) gates UI. Sharing via owner-only `ShareModal` + `/trips/{id}/members`,
plus a public no-login `share_token` link (`shared.py` router / `SharedTripView.jsx`).

- `auth.py` `AUTH_ENABLED` (env). When disabled, middleware passes through, the
  frontend auto-logs-in as a dev user, and all permission checks return `owner`.
- When enabled: middleware validates `Authorization: Bearer <JWT>` except for
  public prefixes/paths (see `auth.py` for the exact allowlist — `/auth/`,
  `/health`, `/currency/`, static assets, `/ingest/`, the share-link routes, etc.).
  `/ingest/` uses its own shared-secret auth (`X-Ingest-Secret` header) and must
  stay localhost-only — Apache never proxies it.
- Google OAuth client id served via `/auth/config`; login posts credential to
  `/auth/google`, returns JWT stored in `localStorage` as `tc-token`.
- The document vault (`UserDocument`) is **not** trip-scoped or role-gated —
  it's owner-only-by-`user_email`, same identity as everything else, but
  outside the `TripMembership` model entirely.

## Offline support

- The app is an installable PWA (`vite-plugin-pwa`, manifest + service worker).
- Read-only offline browsing of the last-loaded trip; an **offline write
  queue** (`offlineQueue.js` + `backend/compare_and_set.py`) lets edits made
  offline sync later, with compare-and-set conflict detection against the
  base value the client last saw (see `docs/plans/plan-11-offline-write-queue.md`).
  `OfflineQueueBanner` surfaces queue state and conflicts.
- Document vault files can be cached for offline viewing per-document
  (`vaultOfflineStore.js`, IndexedDB) via a "Available offline" toggle.
- `useOnline()` (`online.js`) drives the offline banner and gates any
  network-only action across the app.

## Key API endpoints

```
Trips:    GET/POST /trips/ ; GET/PATCH/DELETE /trips/{id} ; GET /trips/{id}/timeline
          /trips/{id}/members (sharing roles — see Sharing below for the public link)
Stops:    GET/POST /trips/{id}/stops ; GET/PATCH/DELETE /stops/{id} ; PATCH /stops/{id}/reorder
Items:    GET/POST /stops/{id}/items ; GET/PATCH/DELETE /items/{id}
          GET /stops/{id}/enrich?kind=&name=&location=  (Google Places autofill; works pre-save)
          GET /items/{id}/flight-check    (AeroDataBox; live status/delay/position)
          GET /items/{id}/rail-check
          POST/GET /items/{id}/gpx ; GET /items/{id}/gpx-map ; GET /items/{id}/river-map
          /items/{id}/attachments  (boarding passes, booking PDFs, QR codes)
          /items/{id}/history       (audit log)
Packing:  GET /trips/{id}/packing ; POST /trips/{id}/packing ; PATCH/DELETE /packing/{id}
          POST /trips/{id}/bags ; PATCH/DELETE /bags/{id}   (nesting, `packed` flag)
Budget:   trip.budget field + BudgetSummary rollup (client-side; see budget.js)
Vault:    /me/documents (+ /{id}/number, /{id}/holder) ; /me/documents/{id}/files
          /me/documents/{id}/files/{file_id}/scan   (local OCR, see passport_ocr.py)
Weather:  GET /weather?start=&end=&lat=&lng=|q=   (cached via WeatherCache)
Push:     GET /push/vapid-public-key ; POST/DELETE /push/subscribe
Calendar: GET /calendar/{token}.ics
Sharing:  GET /shared/{token} ; GET /shared/{token}/timeline   (public, no login)
Import:   POST /import/sheets ; /import/sheets/flights/{trip_id} ; …backfill endpoints
Auth:     POST /auth/google ; GET /auth/me ; GET /auth/config
Me:       GET /me/import-address          (generate/return stable email forwarding address)
Ingest:   POST /ingest/email              (localhost-only; secret-auth; called by postfix pipe)
Pending:  GET /pending[?trip_id=N] ; PATCH /pending/{id} ; POST /pending/{id}/apply|discard
System:   POST /deploy (GitHub webhook, HMAC) ; GET /health ; GET /currency/convert
```

External services: Google Places (`GOOGLE_PLACES_API_KEY`), AeroDataBox
(`AERODATABOX_KEY`), open.er-api.com (currency, no key), Open-Meteo (weather,
no key), OpenStreetMap tiles + OpenTopoData (GPX map/elevation, client-side),
Google Sheets OAuth, Anthropic Claude API (`ANTHROPIC_API_KEY`, email/document
parsing), local Tesseract (`tesseract-ocr` system package, passport OCR —
no external call at all).

## Email ingestion

Users forward booking confirmation emails to a personal address
(`import+<token>@<MAIL_DOMAIN>`). Postfix pipes the raw message to
`scripts/mail_ingest_wrapper.sh`, which calls `mail_ingest.py` (stdlib-only
stdin→POST shim) → `POST /ingest/email` (localhost only, secret-auth) →
`documents.py` (Claude parse, if `ANTHROPIC_API_KEY` set) → `PendingChange` rows.
Frontend: Settings → "Forward bookings by email" (address + regenerate), the
hamburger menu's Imports entry (polled every 60s) opens `PendingReview`.
See `docs/email-ingestion.md` for the full Postfix/DNS setup runbook.

## Build & deploy workflow

See **`CLAUDE.md`** at the repo root for the canonical, up-to-date steps
(frontend build/commit ordering, PR workflow, deploy trigger, health check
fields). Summary: work lands via PRs, squash-merged to `main`; a merge
auto-deploys via webhook → `deploy.sh --update` on the server; verify against
`/health`'s `backend_sha` field (not the frontend-bundle `sha` field, which
lags/orphans on the PR workflow — see CLAUDE.md for why that's expected).

## Server access

SSH: `ssh -i <key> anto@camelidcastle.hups.club`
- App dir `/opt/travelcomp`, service `travelcomp`, deploy log
  `/var/log/travelcomp-deploy.log`, `scripts/smoke_check.sh` for post-deploy checks.

## Scheduled maintenance

- `scripts/send_notifications.py` — cron, ~every 15 min: check-in windows,
  departure lead time, document expiry, live flight delay/cancel/gate alerts.
- `scripts/refresh_weather.py` — nightly cron: pre-warms `WeatherCache`.
- `powerbank-policy-refresh` (Claude routine): monthly on the 20th, refreshes
  `frontend/src/powerbank.js` against current airline rules. Was scoped to
  July/August 2026 only — check whether it's still wanted before it fires again.

## Conventions / gotchas

The non-negotiable, actively-enforced conventions (test gates, Alembic-only
schema changes, `edit-btn` for hover-revealed controls on touch devices,
billed-API item/stop-scoping, naive-UTC datetimes, `flag_modified` for JSON
`details` edits) live in **`docs/plans/README.md`** and **`CLAUDE.md`** — read
those, not just this file, before making a change. A few pointers specific to
this doc:

- `SPEC.md` holds the **original** product spec + data model reference from
  before almost everything in this file existed — it predates permissions,
  email ingestion, packing, the document vault, budget, weather, and more.
  Kept as a historical snapshot, not a current reference.
- The compiled `backend/static/` bundle is committed — always rebuild before
  commit, and as a **separate commit** from the source change (see CLAUDE.md
  for exactly why the ordering matters).
- Tests: `tests/` (pytest backend, ~650+ passing), `frontend/src/__tests__/`
  (vitest + testing-library, ~410+ passing).
