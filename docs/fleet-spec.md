# Fleet spec (DRAFT v0.1)

Common design for the hamBank single-VM web apps: **travelCompantion (TC)**, **pocketMoney (PM)**,
**recipeFlood (RF)**. Derived by inventorying all three, not from one. Each rule says what to do, why
(the incident, where there was one), and how each app stands today.

Levels: **MUST** (break it and something has already broken, or will), **SHOULD** (default; deviate with a
recorded reason), **MAY** (optional building block, specified so apps that need it do it the same way).

Status: `✓` conforms · `~` partly, or does it a different way · `✗` absent · `?` not verified (inventory did not look).

Each app records `spec: 0.1` and its deviations (rule ID + reason) in `.fleet-spec.yml`; a conformance
script checks the rules marked **auto**.

---

## 1. Stack and layout (STK)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| STK-1 | MUST | One uvicorn process serves API and SPA; Vite builds into `backend/static/`; the SPA catch-all is registered **last**. | One thing to deploy, one thing to restart. | ✓ | ✓ | ✓ |
| STK-2 | MUST | App listens on `127.0.0.1:<port>` behind an Apache vhost `<app>.hups.club`. Ports come from one registry (TC 8000, PM 8001, RF 8002). | Collisions on a shared VM. | ✓ | ✓ | ✓ |
| STK-3 | SHOULD | Routes at top level, no `/api` prefix; the Vite dev proxy lists the prefixes. | Matches all three today. | ✓ | ✓ | ✓ |
| STK-4 | SHOULD | Lowercase app name for system user, `/opt/<app>`, units, log paths. | RF needs `useradd --badname` for `recipeFlood`; PM user/dir are mixed case. | ✓ | ~ | ~ |
| STK-5 | MUST | Python deps: floor = the real minimum the code needs; cap the next breaking major for libraries whose changes bite (sqlmodel, pydantic, sqlalchemy). **auto** (a test parses `requirements.txt`). | `deploy.sh` re-runs `pip install` into a long-lived venv, so a too-low floor never upgrades it (TC 2026-10-28: prod stayed on sqlmodel 0.0.39, deploy died in Alembic). CI builds a fresh venv and cannot see this. | ~ | ✓ | ~ |
| STK-6 | SHOULD | One Postgres driver across the fleet. | TC `psycopg[binary]` (v3); PM, RF `psycopg2-binary`. They behave differently (see DB-6). | ✓ | ✗ | ✗ |
| STK-7 | SHOULD | Frontend: React + Vite + Tailwind, plain JS/JSX, vitest + jsdom, eslint. | All three. | ✓ | ✓ | ✓ |

## 2. Configuration (CFG)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| CFG-1 | SHOULD | Config in one pydantic-settings `Settings` class that reads env vars; systemd loads `.env` via `EnvironmentFile`; `.env` is `chmod 600`; `.env.example` lists **every** variable. **auto** (every `Settings` field appears in `.env.example`). | TC reads `os.environ` in scattered module constants. | ~ | ✓ | ✓ |
| CFG-2 | MUST | Startup **fails** if auth is enabled and `JWT_SECRET` is the default. **auto** | All three default to a public string (`dev-secret-change-…`). A missing env var means forgeable tokens. | ✗ | ✗ | ✗ |
| CFG-3 | MUST | `AUTH_ENABLED` is an explicit variable and fails closed in production. | TC derives it from `GOOGLE_CLIENT_ID` being non-empty: lose that line from `.env` and auth silently turns off. | ✗ | ✓ | ✓ |
| CFG-4 | SHOULD | Allowlist variable is `ALLOWED_EMAILS` (comma list). | TC uses singular `ALLOWED_EMAIL`. | ~ | ✓ | ✓ |
| CFG-5 | SHOULD | Auth-disabled dev identity is `dev@localhost`. | TC uses `dev@local`. | ~ | ✓ | ✓ |
| CFG-6 | SHOULD | Values with spaces are double-quoted (systemd and bash both parse `.env`); inline comments are not relied on. | RF needs a validator to strip them. | ? | ✓ | ✓ |

## 3. Database (DB)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| DB-1 | MUST | Alembic owns the schema; models are the source of truth; **a drift check runs in CI** (`alembic check` or a pytest guard). **auto** | Tests use `create_all()` for speed, so the guard keeps it honest. | ✓ | ✓ | ✓ |
| DB-2 | MUST | Postgres in prod; SQLite for dev and the fast test job. | All three. | ✓ | ✓ | ✓ |
| DB-3 | MUST | A CI job exercises Alembic on real Postgres (upgrade, `check`; ideally `downgrade base` and back). | RF: a baseline `downgrade()` once left five orphaned enum types. | ✓ | ✗ | ~ |
| DB-4 | SHOULD | Run the **whole** test suite against Postgres too. | Dialect bugs pass SQLite (FKs, JSON, enums, datetimes). Only TC does. | ✓ | ✗ | ✗ |
| DB-5 | MUST | Instants (`created_at`, `sent_at`, …) are **aware UTC**, written with `datetime.now(timezone.utc)`. Local wall-clock fields (arrive/depart, scheduled times) are explicitly naive (`NaiveDatetime`) and documented as such. | SQLModel ≥0.0.45 rejects naive values on plain `datetime`. TC 2026-09-23: ~300 failures at once. | ✓ | ✓ | ✓ |
| DB-6 | MUST | If tests rebuild the schema per test on a pooled Postgres engine, `engine.dispose()` after `create_all()`. | psycopg3 server-side-prepares repeated statements; recreated tables then fail with "cached plan must not change result type". TC 2026-10-28. | ✓ | n/a | n/a |
| DB-7 | SHOULD | Migrations work on SQLite **and** Postgres; enums use `native_enum=False`. | RF: enum-widening migrations diverged between dialects. | ? | ✓ | ✓ |
| DB-8 | OPEN | Column type for instants: `timestamptz` (PM migrated to it) or `timestamp` read back as UTC (TC). | See decision D3. | ~ | ~ | ~ |

## 4. Authentication (AUTH)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| AUTH-1 | MUST | Google ID token → verified server-side → app JWT (HS256), `JWT_EXPIRE_DAYS` default 30, stored in localStorage. | All three. | ✓ | ✓ | ✓ |
| AUTH-2 | MUST | **Sliding session, server-driven:** once a login token is past half its life, any authenticated response carries a fresh one in `X-Refreshed-Token`. Login tokens only, never PATs; error responses never; the sign-in gate is re-checked so revoked users cannot extend. Tokens carry `iat`. **auto** (contract test) | No polling, no extra endpoint; works for every client. | ✓ | ✓ | ✓ |
| AUTH-3 | MUST | The sign-in gate (allowlist or membership) is **one function** shared by login, refresh and the sliding refresh. | Revoking someone must stop all three. | ✓ | ? | ? |
| AUTH-4 | MUST | Frontend has **one** authenticated-fetch wrapper; blob, upload and download helpers use it too. It stores a refreshed token only if the token it sent is still the stored one, and a 401 on a request that sent a token clears it and shows login (also only if unchanged). | TC had ~14 helpers calling `fetch` directly that never signed out on 401; a late response could write a token back after sign-out. | ~ | ~ | ✓ |
| AUTH-5 | MUST | The 401 → login listener is attached from first render, not after `/auth/config` resolves. | A token that expired while the app was closed 401s at boot, before the config lands; the event was lost. | ✓ | ? | ? |
| AUTH-6 | SHOULD | Public vs protected is decided in **one** place. TC: middleware with a public-prefix list. PM/RF: per-route dependencies. Pick one. | Two models in one fleet means two audit methods. | ~ | ~ | ~ |
| AUTH-7 | MAY | Personal API tokens: `scope: "api"` + `jti` backed by a DB row, revocable, fixed lifetime, **not** exchangeable at `/auth/refresh`. | An exchangeable PAT minted a 30-day login token that revoking it couldn't undo (TC, fixed in #200). | ✓ | n/a | n/a |
| AUTH-8 | SHOULD | JWT library: PyJWT. | TC uses python-jose. | ✗ | ✓ | ✓ |

## 5. Deploy and operations (DEP)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| DEP-1 | MUST | `deploy.sh`: bare = idempotent full provision, `--update` = code only. `set -Eeuo pipefail` plus an ERR trap logging `file:line` to `/var/log/<app>-deploy.log`. **auto** (grep) | RF's trap exists because of silent early failures. | ~ | ~ | ✓ |
| DEP-2 | MUST | Trigger chain: GitHub push webhook → `POST /deploy` (HMAC `X-Hub-Signature-256` with `DEPLOY_SECRET`, `main` only) → touch `.deploy-trigger` → systemd `.path` → oneshot `deploy.sh --update`. | Identical in all three. | ✓ | ✓ | ✓ |
| DEP-3 | MUST | The trigger file is removed at the **start** of the deploy; a lock makes overlapping deploys skip cleanly. | Otherwise a failed deploy re-fires forever. | ✓ | ? | ? |
| DEP-4 | MUST | Post-deploy **smoke check** that waits (≤60s) for `/health`, checks `status`, checks `backend_sha` equals the pulled SHA, hits one data endpoint, requires every scheduled unit's last `Result=success`, and checks backup freshness. `deploy.sh` finishes, then **exits non-zero** if it failed. **auto** (script present and called) | A deploy must not fail semi-silently. TC: HTTP 000 from racing the restart; a failing weather job hidden behind green deploys (systemd reports `exit-code`, not `failed`). | ✓ | ✗ | ✗ |
| DEP-5 | SHOULD | Scheduled jobs are systemd **timers** with oneshot services. | A timer has a queryable `Result`; cron failures vanish into a log. | ✓ | ✗ | ✗ |
| DEP-6 | MUST | Daily `pg_dump`, rotated, **plus an off-box copy**; stagger start times across apps (PM 02:30, RF 02:45). | PM's docs still say "TODO off-server". | ~ | ~ | ~ |
| DEP-7 | MUST | Deploy re-asserts `chmod +x` on scripts. | TC: `pg_backup.sh` committed without +x failed every night. | ✓ | ? | ? |
| DEP-8 | SHOULD | Never overwrite an Apache vhost certbot already owns; never reload Apache onto a broken config. | RF. | ? | ? | ✓ |

## 6. Health and observability (OBS)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| OBS-1 | MUST | `GET /health` returns `{status, backend_sha, frontend_sha, built_at, started_at}` (+ `data_version` if the app syncs devices) and pings the DB. **auto** | Field names differ today (TC `sha`/`backend_sha`/`started_at`/`data_version`; PM, RF `backend_version`/`frontend_version`/`frontend_built_at`). The smoke check and any fleet tooling need one shape. See D2. | ~ | ~ | ~ |
| OBS-2 | SHOULD | `/metrics` (Prometheus) with a `<app>_external_requests_total{service=…}` counter, and an alert-rules file in `docs/`. | TC only. | ✓ | ✗ | ✗ |
| OBS-3 | MUST | Before wiring a metered external API into any recurring job: `calls per tick × ticks per month` against the provider quota. Paid-API scripts take `--limit` and `--budget`. | TC burned a 600/month AeroDataBox quota in days from an unconditional 15-minute poll. | ✓ | n/a | ~ |
| OBS-4 | SHOULD | Logs go to journald; the deploy log is `/var/log/<app>-deploy.log`. | All three. | ✓ | ✓ | ✓ |

## 7. CI and tests (CI, TST)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| CI-1 | MUST | GitHub Actions on PR and push to `main`: `backend` (SQLite), `frontend` (lint, test, build), and a Postgres job (DB-3/DB-4). | | ✓ | ~ | ✓ |
| CI-2 | MUST | CI is the merge gate. PRs are **non-draft**; squash-merge; auto-merge on. | Draft PRs block auto-merge. | ✓ | ✗ | ~ |
| CI-3 | MUST | Install-time version problems are guarded by a test, not left to CI's fresh venv (STK-5). | | ✓ | n/a | ✗ |
| TST-1 | MUST | Tests never depend on the real date: pin the clock or build dates relative to now. | TC 2026-10-28: two tests hard-coded Sept/Oct 2026 and went red as time passed. | ✓ | ? | ? |
| TST-2 | SHOULD | Bug fixes land red-then-green: show the new test failing on the old code. | TC practice. | ✓ | ✗ | ✗ |
| TST-3 | SHOULD | `scripts/install-hooks.sh` installs a pre-push hook that runs the cheap checks. | TC only. | ✓ | ✗ | ✗ |

## 8. Frontend (FE)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| FE-1 | SHOULD | Stale-client detection: the client compares its baked SHA to `/health` and reloads on mismatch. | PM, RF only write `version.json`; nothing reads it client-side. | ✓ | ✗ | ✗ |
| FE-2 | SHOULD | PWA with service worker for apps used on the move; an offline **write** queue only where the app needs one. | TC full queue; RF shopping-list outbox; PM manifest only. | ✓ | ✗ | ~ |
| FE-3 | SHOULD | Views people share have real URLs (deep links). The server serves the SPA shell for those paths without shadowing an API route that shares the path (`Vary: Accept`, `no-store`). | RF hit a cached HTML shell served to the app's own `fetch()`. | ✓ | ✗ | ✓ |
| FE-4 | OPEN | Whether `backend/static/` is committed (TC, two-commit rule) or gitignored and built by the deploy (PM, RF). | See decision D1. | ~ | ~ | ~ |

## 9. Process (PRC)

| ID | Lvl | Rule | Why / note | TC | PM | RF |
|---|---|---|---|---|---|---|
| PRC-1 | MUST | Root `CLAUDE.md`: run, DB, build, git workflow, and an **incident-driven rules** section where each rule names the incident and date. **auto** (file exists) | The rules that save time are the ones written after something broke. | ✓ | ✗ | ✗ |
| PRC-2 | SHOULD | `.claude/settings.json` SessionStart hook (remote sessions only) that creates the venv, installs deps and exports `AUTH_ENABLED=false`. | RF has it; TC and PM can't run tests in a fresh remote session without extra setup. | ✗ | ✗ | ✓ |
| PRC-3 | MUST | Flow: branch → PR → CI → squash-merge → auto-deploy → verify `/health` `backend_sha`. | | ✓ | ~ | ~ |
| PRC-4 | SHOULD | Feature plans in `docs/plans/`; reference docs `ARCHITECTURE`, `DATA_MODEL`, `API`, `DEPLOYMENT`, `DEVELOPMENT`. | TC plans; PM, RF reference docs. | ~ | ~ | ~ |

---

## Open decisions

| # | Question | Leaning |
|---|---|---|
| D1 | Commit `backend/static/` (TC) or build on deploy (PM, RF)? | Build on deploy. Removes the two-commit rule, orphaned baked SHAs and bundle churn in git. Needs a check that TC's deploy already builds (its header says so). |
| D2 | `/health` field names. | TC's names plus `built_at`: `backend_sha`, `frontend_sha`, `built_at`, `started_at`. |
| D3 | sqlmodel range and instant column type. | One range fleet-wide (PM pins `0.0.48` exactly; RF caps `<0.0.45`, so it can't take the datetime change; TC floors `>=0.0.45`). `timestamptz` for instants. |
| D4 | Postgres driver. | psycopg3, but only after checking PM and RF's tests for the prepared-statement behaviour (DB-6). |
| D5 | Scheduled jobs: systemd timers or cron? | Timers (DEP-4 depends on `Result`). |
| D6 | Public-route model: middleware list or per-route dependencies? | Middleware list as a backstop plus per-route checks; fail closed on new routes. |
| D7 | Naming (STK-4): migrate PM and RF to lowercase? | Grandfather the two; the spec applies to new apps and records the deviation. |
| D8 | Where the spec lives. | A separate `hamBank/fleetSpec` repo: this file, a portable `smoke_check.sh`, a conformance script, and a template `CLAUDE.md`. |

## Findings that are not just differences

1. **CFG-2:** all three accept a well-known default `JWT_SECRET`.
2. **CFG-3:** TC turns auth off if `GOOGLE_CLIENT_ID` is missing from `.env`.
3. **DEP-4:** only TC would notice a failing nightly job or a bad deploy; PM and RF rely on a human running `curl /health`.
4. **STK-5/D3:** RF's `sqlmodel<0.0.45` cap is the opposite of TC's required floor, so the two cannot share datetime conventions as they stand.

## Not verified

TC `set -E`/ERR trap and its frontend lint job; DEP-3/DEP-7/DEP-8 in PM and RF; AUTH-3/AUTH-5 in PM and RF; DB-7 in TC. Shallow clones, no history.
