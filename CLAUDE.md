# Travel Companion — Claude Instructions

## Project
FastAPI + SQLModel backend, React + Vite + Tailwind frontend.
Frontend is compiled into `backend/static/` and served by the same FastAPI process.

## Running the app
```bash
python -m uvicorn backend.main:app --reload
# → http://localhost:8000
```

## Frontend build (required after any change to frontend/src/)
```bash
cd frontend && npm run build
# Outputs to backend/static/ — commit those files too
```

## Repository
- Remote: https://github.com/hamBank/travelCompantion.git
- PAT stored in Claude memory (project_travel_app.md)
- Always use HTTPS with PAT for git push

## Git workflow
1. Create a branch from `origin/main`
2. Edit source files
3. If any `frontend/src/` files changed, run `npm run build` inside `frontend/`
4. Commit source files + `backend/static/` together
5. Push branch to origin
