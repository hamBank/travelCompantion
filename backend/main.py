import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from .database import create_db_and_tables
from .routers import trips, stops, items, sheets_import
from .routers.auth_router import router as auth_router

# Paths that never require authentication (static assets + public endpoints)
_PUBLIC_PREFIXES = ("/auth/", "/health", "/assets/", "/sw.", "/registerSW.", "/manifest.")
_PUBLIC_EXACT    = {"/", "/index.html", "/privacy.html", "/tos.html",
                    "/favicon.ico", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    yield


app = FastAPI(title="Travel Companion API", version="0.1.0", lifespan=lifespan)

app.include_router(auth_router)
app.include_router(trips.router, prefix="/trips", tags=["trips"])
app.include_router(stops.router, tags=["stops"])
app.include_router(items.router, tags=["items"])
app.include_router(sheets_import.router)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    from .auth import AUTH_ENABLED, JWT_SECRET, JWT_ALGORITHM
    if not AUTH_ENABLED:
        return await call_next(request)

    path = request.url.path
    if path in _PUBLIC_EXACT or any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return await call_next(request)

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)

    from jose import JWTError, jwt
    try:
        jwt.decode(auth_header[7:], JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        return JSONResponse({"detail": "Invalid or expired token"}, status_code=401)

    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


# Serve the compiled React frontend — must come after all API routes
_static = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
