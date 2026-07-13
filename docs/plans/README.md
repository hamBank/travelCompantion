# Feature plans — shared context

Self-contained implementation plans, written to be executed independently by
an agent with no prior context on this repo. **Read this file first, then your
assigned plan.** Each plan is one PR-sized unit of work.

| Plan | Feature | Effort | Depends on |
|------|---------|--------|-----------|
| [plan-1-today-view.md](plan-1-today-view.md) | "Today" view for in-trip use | S–M | — |
| [plan-2-flight-delay-alerts.md](plan-2-flight-delay-alerts.md) | Push alerts for flight delays/cancellations/gate changes | M | — |
| [plan-4-offline-hardening.md](plan-4-offline-hardening.md) | Close remaining offline-PWA gaps | S | — |
| [plan-5-budget-dashboard.md](plan-5-budget-dashboard.md) | Per-trip budget + spend rollup | M | — |
| [plan-8-auto-complete-past-items.md](plan-8-auto-complete-past-items.md) | One-click catch-up for past items | S | — |
| [plan-10-aircraft-position.md](plan-10-aircraft-position.md) | "Where is my plane" position display | S | plan-2 (shares `backend/flight_live.py`) |
| [plan-11-offline-write-queue.md](plan-11-offline-write-queue.md) | Offline write queue + basic conflict resolution | M–L | read-only offline (shipped, PR #57) |
| [plan-12-document-vault.md](plan-12-document-vault.md) | Secure offline-accessible document vault (passport/licence expiry) | L | — (supersedes issue #60) |
| [plan-12a-document-vault-crud.md](plan-12a-document-vault-crud.md) | Document vault — backend data model, encryption, CRUD API only | M | plan-12 (subplan; UI/offline cache/expiry cron deferred) |
| [plan-12b-document-vault-expiry.md](plan-12b-document-vault-expiry.md) | Document vault — expiry reminder push notification cron | S | plan-12a |
| [plan-12c-document-vault-ui.md](plan-12c-document-vault-ui.md) | Document vault — Settings UI, viewer, offline cache | M | plan-12a |
| [plan-13-passport-ocr.md](plan-13-passport-ocr.md) | Passport MRZ OCR (local Tesseract, no cloud call) with per-field selectable review | M | plan-12a, plan-12c (reads/writes the Documents section) |

If implementing both plan-2 and plan-10, do plan-2 first — it extracts the
AeroDataBox fetch into `backend/flight_live.py`, which plan-10 then reuses.

## Non-negotiable project conventions

1. **Test gates.** Run BOTH suites before every push; never skip:
   - Backend: `python -m pytest -q` from the repo root (expect ~650+ passing).
   - Frontend: `cd frontend && npx vitest run` (expect ~410+ passing).
   - Write tests for new behavior FIRST or alongside — every plan lists the
     tests expected of it.

2. **Frontend build/push workflow** (enforced by a pre-push git hook — see
   `CLAUDE.md` at the repo root for the canonical steps). If any file under
   `frontend/src/` changed:
   1. commit the source change;
   2. `cd frontend && npm run build` (bakes the commit SHA into the bundle);
   3. `git add backend/static/ && git commit -m "Build frontend for <sha>"` —
      **a separate commit, not an amend** (amending would rewrite the very
      commit hash the build just baked in);
   4. push. Backend-only changes push normally, no build needed.

3. **Datetimes are naive UTC throughout the backend.** DB columns, JWT expiry,
   and comparisons all use naive datetimes. Never introduce aware datetimes
   into stored/compared values; use
   `datetime.now(timezone.utc).replace(tzinfo=None)` (never `utcnow()` — it is
   deprecated and was purged from this codebase). `backend/notifications.py`
   has `_local_to_utc(dt_str, tz)` for converting stored local wall-clock
   strings + timezone (e.g. `"2026-07-24T21:35"` + `"GMT+8"`) to naive UTC.

4. **`ItineraryItem.details` is a JSON blob.** When mutating it on a fetched
   ORM object, reassign a new dict (`item.details = {**item.details, ...}`) or
   call `flag_modified(item, 'details')` (see `backend/routers/items.py` and
   `backend/routers/pending.py` for both patterns) or SQLAlchemy won't persist
   the change.

5. **Schema changes go through Alembic.** Models in `backend/models.py` are the
   source of truth. After any model change:
   `alembic revision --autogenerate -m "..."` → review the generated file →
   `alembic upgrade head` → `python -m pytest tests/test_alembic_drift.py`
   must stay green. Prod runs Postgres; local dev/tests use SQLite — avoid
   dialect-specific column types.

6. **Hover-revealed controls need the `edit-btn` class.** Anything shown via
   `opacity-0 group-hover:opacity-100` is invisible on touch devices unless it
   also carries `edit-btn` (an app-wide `@media (hover: none)` override in
   `frontend/src/index.css` forces those visible). This has bitten this repo
   before — don't repeat it.

7. **Billed external APIs are only ever called item/stop-scoped.** Endpoints
   that hit Google/AeroDataBox read stored rows rather than accepting arbitrary
   query params, so an authenticated user can't relay unlimited billed calls
   (see the docstring on `river_map` in `backend/routers/items.py`).

## Orientation (60-second repo tour)

- FastAPI + SQLModel backend (`backend/`), React+Vite+Tailwind frontend
  (`frontend/src/`), compiled into `backend/static/` and served by the same
  process. `ARCHITECTURE.md` at the repo root has the full picture.
- Hierarchy: Trip → Stop → ItineraryItem. Per-kind data lives in
  `item.details` (JSON). Item kinds and labels: `frontend/src/kinds.js`.
- `frontend/src/api.js` — every endpoint helper; follow its `req()` pattern.
- `frontend/src/components/StopCard.jsx` — per-kind cards + exported helpers
  `itemSortKey`, `itemDateKey`, `itemTimeStr`, `toUtcMs`.
- `frontend/src/components/TripTimeline.jsx` — trip view: fetches
  `/trips/{id}/timeline`, renders `StopCard`s, has a 30s `/health` data-sync
  poller and a `renderKey` remount trick for silent refreshes.
- `frontend/src/App.jsx` — shell: auth gate; header with a hamburger
  `MenuDropdown` (Edit/View, Packing/Timeline, Share, Export PDF, Budget,
  Imports, Documents, Settings, theme picker, Sign out — everything not used
  every session); footer keeps only what's used constantly (Today/All-days
  toggle, kind filter *or*, while in Packing view, a "hide packed" filter in
  the same slot, Import from document, Add item). View switching via
  `packing`/`editing` state, `useOnline()` hook + offline banner.
- `backend/notifications.py` + `scripts/send_notifications.py` — push
  notification triggers, run by cron every ~15 min on the server with
  `DATABASE_URL` and `VAPID_PRIVATE_KEY` set. Idempotency via `NotificationLog`
  rows keyed on `(item_id, kind)` — kind is a free string.
- `backend/routers/items.py` — item CRUD plus `check_flight` (AeroDataBox live
  flight lookup: status/delays/distance), Static Maps proxy helpers.
- Backend test fixtures (`client`, `session`) live in `tests/conftest.py`;
  frontend tests in `frontend/src/__tests__/` (vitest + testing-library,
  `vi.mock('../api.js')` pattern — see `PackingList.test.jsx`).

## Verifying UI changes

Frontend behavior should be spot-checked in a real browser before pushing.
Run the backend (`python -m uvicorn backend.main:app --reload`) and the Vite
dev server (`cd frontend && npm run dev`, proxies API to :8000), create test
data via curl against `http://localhost:8000` (auth is disabled without
`GOOGLE_CLIENT_ID`), and check the affected flow. For flows that depend on
external APIs you don't have keys for, stub `window.fetch` for that endpoint
in the browser console — several past fixes were verified this way.
