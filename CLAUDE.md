# Travel Companion — Claude Instructions

## Project
FastAPI + SQLModel backend, React + Vite + Tailwind frontend.
Frontend is compiled into `backend/static/` and served by the same FastAPI process.

## Running the app
```bash
python -m uvicorn backend.main:app --reload
# → http://localhost:8000
```

## Database & schema migrations
`DATABASE_URL` selects the backend (defaults to `sqlite:///./travel.db`; Postgres
in prod). Schema is owned by **Alembic** — the models in `backend/models.py` are
the source of truth. After any model change:
```bash
alembic revision --autogenerate -m "describe change"   # review the file
alembic upgrade head
python -m pytest tests/test_alembic_drift.py            # must stay green
```
The URL comes from `DATABASE_URL` via `alembic/env.py` (not alembic.ini). See
`docs/postgres-migration.md` for the full runbook. Tests use `create_all()` for
speed; the drift guard keeps that in sync with the migrations.

## Frontend build
The app bakes the current git SHA into the JS bundle so the SHA health-poller can
detect stale clients. The build MUST run after the source commit so it captures the
correct SHA. Always follow this order:

```bash
# 1. Commit source changes (frontend/src/ and/or backend/)
git add ...
git commit -m "..."

# 2. Build — HEAD is now the new commit, so the correct SHA is baked in
cd frontend && npm run build

# 3. Commit the build output as its OWN commit (do NOT amend — see below)
cd ..
git add backend/static/
git commit -m "Build frontend for <short-sha-from-step-1>"

# 4. Push
git push origin main
```

**NEVER** skip steps 2–3 when `frontend/src/` files changed — the old compiled bundle
will be served and the SHA health-poller will loop or show stale features.

**Do not use `git commit --amend` for the build commit.** `npm run build` computes
the baked SHA as `git log -1 --format=%h -- src` — the hash of the commit that last
touched `frontend/src`. Amending that same commit to add `backend/static/` rewrites
its own hash, so the SHA baked into `build-sha.txt` / `__BUILD_SHA__` ends up
referring to a commit that no longer exists post-amend. This was silently wrong on
every prior deploy (confirmed via git history 2026-07-05) — harmless for the actual
stale-client-reload check (client and server both come from the same build, so they
still agree with each other), but it means the SHA shown in the footer and `/health`
never matched the real deployed commit, defeating its value for debugging deploys.
Committing the build output separately means `build-sha.txt` will be one commit
"behind" HEAD (pointing at the source commit, not the follow-up build commit) — that
mismatch is expected and fine; the SHA it reports is a real, permanent, reachable
commit that accurately represents the deployed code, which is what matters.

A pre-push git hook enforces this automatically. Install it once per clone:
```bash
bash scripts/install-hooks.sh
```
The hook aborts the push with a clear error if `frontend/src/` changed but
`backend/static/` was not rebuilt in the same set of commits.

**PR-workflow caveat (squash-merge orphans baked SHAs).** The two-commit rule
above was written for direct pushes to `main`. On the PR workflow (below), the
squash-merge rewrites the branch's commits into one new commit on `main`, so
whatever SHA got baked on the branch — amended or not — refers to a commit that
no longer exists after merge. That's accepted: the baked SHA still does its real
job (stale-client reload detection — client and server come from the same build,
so they agree with each other), but it is NOT a deploy identifier. To verify
what's actually deployed, use the `backend_sha` field in `/health` (the backend's
`git rev-parse` at startup — always a real, reachable `main` commit), not the
`sha` field, which is the frontend-bundle bake and lags/orphans as described.

## Repository
- Remote: https://github.com/hamBank/travelCompantion.git
- PAT stored in Claude memory (project_travel_app.md)
- Always use HTTPS with PAT for git push

## Git workflow (PRs, not direct pushes)
Work lands via pull requests, squash-merged to `main`:
1. Develop on a feature branch cut from fresh `origin/main`. Commit source
   first; if `frontend/src/` changed, build and include `backend/static/`
   (on a squashed branch the amend-vs-separate distinction no longer matters —
   see the caveat above — but the build must still happen AFTER the source
   commit, and never be skipped).
2. Run the test suites (`python -m pytest tests/ -q`, `cd frontend && npx
   vitest run`) before pushing.
3. Push the branch, open the PR **non-draft** (draft PRs block auto-merge),
   and enable auto-merge (squash) immediately — or merge directly once CI is
   green. CI (backend + frontend checks) is the merge gate; speed of
   deployment is deliberately prioritized while the app is single-user.
4. Merges to `main` auto-deploy via the server's webhook → `.deploy-trigger`
   path watcher (`deploy.sh --update`). If a merge doesn't appear on the
   server within a few minutes, it can be forced: `sudo ./deploy.sh --update`.
5. Verify the deploy against `/health`'s `backend_sha` (and `scripts/
   smoke_check.sh` on the server), not the `sha` field.
6. After each squash-merge, reset the working branch onto `origin/main`
   before starting the next change (the old branch commits are orphaned).

## Weather cache — change checklist
`WeatherCache` rows are served for hours-to-days (variable TTL in
`backend/routers/weather.py`). When changing weather logic, ask: "does this
change make previously cached payloads wrong?" If yes — payload shape OR
semantics (e.g. horizon math, source classification), not just shape — **bump
`CACHE_VERSION` in `backend/weather.py`** so every stale entry misses instead
of serving the old bug for up to 48h. Forgetting this cost several rounds of
manual SQL cache-clearing in production (2026-07-06).
