import os, hmac, hashlib, json, logging, logging.handlers
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from .database import create_db_and_tables
from .routers import trips, stops, items, sheets_import, documents, pending, ingest, me, weather, packing, push
from .routers.auth_router import router as auth_router
from . import metrics as _metrics  # registers all travelcomp_* counters at startup

# ── Structured logging ────────────────────────────────────────────────────────

_LOG_DIR  = os.getenv("LOG_DIR", "/var/log/travelcomp")
_LOG_FILE = os.path.join(_LOG_DIR, "app.log")


class _JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        from datetime import datetime, timezone
        d: dict = {
            "ts":      datetime.now(timezone.utc).isoformat(),
            "level":   record.levelname,
            "logger":  record.name,
            "msg":     record.getMessage(),
        }
        if record.exc_info:
            d["exc"] = self.formatException(record.exc_info)
        for key in ("path", "method", "status_code", "duration_ms"):
            if hasattr(record, key):
                d[key] = getattr(record, key)
        return json.dumps(d)


def _setup_logging() -> None:
    try:
        os.makedirs(_LOG_DIR, exist_ok=True)
        handler: logging.Handler = logging.handlers.RotatingFileHandler(
            _LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=7, encoding="utf-8",
        )
    except (PermissionError, OSError):
        handler = logging.StreamHandler()   # fallback for local dev

    handler.setFormatter(_JSONFormatter())
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    # Avoid double-adding during hot-reload
    if not any(isinstance(h, (logging.handlers.RotatingFileHandler, logging.StreamHandler)
                             and type(h) is type(handler)) for h in root.handlers):
        root.addHandler(handler)


_setup_logging()
logger = logging.getLogger(__name__)

# ── Public path lists ─────────────────────────────────────────────────────────
# /metrics is unauthenticated — Prometheus scrapers don't carry user JWTs.
# Metrics contain only aggregate counts/durations; no PII.
_PUBLIC_PREFIXES = ("/auth/", "/health", "/metrics", "/currency/", "/weather",
                    "/push/vapid-public-key", "/assets/",
                    "/sw.", "/sw-update", "/sw-push", "/workbox-", "/registerSW.", "/manifest.",
                    "/coverage", "/ingest/")
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

# ── Prometheus HTTP metrics ───────────────────────────────────────────────────
try:
    from prometheus_fastapi_instrumentator import Instrumentator
    Instrumentator(
        should_group_status_codes=True,
        excluded_handlers=["/metrics", "/health", r"^/assets/.*"],
    ).instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)
except ImportError:
    logger.warning("prometheus-fastapi-instrumentator not installed — /metrics unavailable")

app.include_router(auth_router)
app.include_router(trips.router, prefix="/trips", tags=["trips"])
app.include_router(stops.router, tags=["stops"])
app.include_router(items.router, tags=["items"])
app.include_router(sheets_import.router)
app.include_router(documents.router, tags=["documents"])
app.include_router(pending.router, tags=["pending"])
app.include_router(ingest.router, tags=["ingest"])
app.include_router(me.router, tags=["me"])
app.include_router(weather.router, tags=["weather"])
app.include_router(packing.router, tags=["packing"])
app.include_router(push.router, tags=["push"])


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


def _frontend_sha():
    """Return the SHA baked into the frontend build (written by vite at build time).

    Using the build SHA rather than git HEAD means backend-only commits don't
    cause the SHA health-poller to reload all clients — only actual frontend
    rebuilds advance the value the poller compares against.
    """
    build_sha_file = os.path.join(os.path.dirname(__file__), "static", "build-sha.txt")
    try:
        with open(build_sha_file) as f:
            sha = f.read().strip()
            if sha:
                return sha
    except Exception:
        pass
    # Fallback: git HEAD (old behaviour, used before build-sha.txt exists on server)
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
    from .database import get_data_version
    return {"status": "ok", "sha": _frontend_sha(), "data_version": get_data_version()}


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
