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

## Repository
- Remote: https://github.com/hamBank/travelCompantion.git
- PAT stored in Claude memory (project_travel_app.md)
- Always use HTTPS with PAT for git push

## Git workflow
1. Commit source files
2. If any `frontend/src/` files changed, build then amend (see above)
3. Push — use `--force-with-lease` when amending main
