# Travel Companion — Claude Instructions

## Project
FastAPI + SQLModel backend, React + Vite + Tailwind frontend.
Frontend is compiled into `backend/static/` and served by the same FastAPI process.

## Running the app
```bash
python -m uvicorn backend.main:app --reload
# → http://localhost:8000
```

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

# 3. Amend the build output into the same commit
cd ..
git add backend/static/
git commit --amend --no-edit

# 4. Push
git push origin main          # or --force-with-lease for amended commits on main
```

Never build before committing — __BUILD_SHA__ will be one commit behind and the
SHA health-poller will reload the page in an infinite loop.

## Repository
- Remote: https://github.com/hamBank/travelCompantion.git
- PAT stored in Claude memory (project_travel_app.md)
- Always use HTTPS with PAT for git push

## Git workflow
1. Commit source files
2. If any `frontend/src/` files changed, build then amend (see above)
3. Push — use `--force-with-lease` when amending main
