import os, hmac, hashlib, json
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from .database import create_db_and_tables
from .routers import trips, stops, items, sheets_import, documents, pending
from .routers.auth_router import router as auth_router

# Paths that never require authentication (static assets + public endpoints).
# Service-worker scripts and their importScripts deps (workbox-*, sw-update) must
# be reachable without a token or the SW can't install/update.
_PUBLIC_PREFIXES = ("/auth/", "/health", "/currency/", "/assets/", "/sw.", "/sw-update", "/workbox-", "/registerSW.", "/manifest.", "/coverage")
_PUBLIC_EXACT    = {"/", "/index.html", "/privacy.html", "/tos.html",
                    "/favicon.ico", "/icon-192.png", "/icon-512.png",
                    "/apple-touch-icon.png", "/deploy"}

_DEPLOY_SECRET = os.getenv("DEPLOY_SECRET", "").encode()
_TRIGGER       = Path(__file__).parent.parent / ".deploy-trigger"


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
app.include_router(documents.router, tags=["documents"])
app.include_router(pending.router, tags=["pending"])


@app.post("/deploy")
async def webhook_deploy(request: Request):
    if not _DEPLOY_SECRET:
        raise HTTPException(status_code=503, detail="Deploy webhook not configured (set DEPLOY_SECRET)")
    body = await request.body()
    sig      = request.headers.get("X-Hub-Signature-256", "")
    expected = "sha256=" + hmac.new(_DEPLOY_SECRET, body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=403, detail="Bad signature")
    if request.headers.get("X-GitHub-Event") == "push":
        try:
            if json.loads(body).get("ref") == "refs/heads/main":
                _TRIGGER.touch()
        except Exception:
            pass
    return {"ok": True}


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


def _git_sha():
    try:
        import subprocess
        return subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=os.path.dirname(__file__),
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return 'unknown'

@app.get("/health")
def health():
    return {"status": "ok", "sha": _git_sha()}


@app.get("/currency/convert")
async def currency_convert(amount: float, from_currency: str, to_currency: str):
    import asyncio, urllib.request, urllib.parse, json as _json
    if from_currency == to_currency:
        return {"rate": 1.0, "result": amount}

    def _fetch():
        url = f"https://open.er-api.com/v6/latest/{from_currency}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return _json.loads(r.read().decode())

    try:
        loop = asyncio.get_event_loop()
        data = await asyncio.wait_for(loop.run_in_executor(None, _fetch), timeout=10.0)
        if data.get("result") == "error":
            raise HTTPException(status_code=502, detail=data.get("error-type", "unknown error"))
        rate = data.get("rates", {}).get(to_currency)
        if rate is None:
            raise HTTPException(status_code=502, detail=f"No rate returned for {to_currency}")
        result = round(amount * rate, 2)
        return {"rate": round(rate, 6), "result": result}
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Currency API timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Currency conversion failed: {e}")


# Serve the compiled React frontend — must come after all API routes
_static = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
