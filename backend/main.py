import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from .database import create_db_and_tables
from .routers import trips, stops, items, sheets_import


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    yield


app = FastAPI(title="Travel Companion API", version="0.1.0", lifespan=lifespan)

app.include_router(trips.router, prefix="/trips", tags=["trips"])
app.include_router(stops.router, tags=["stops"])
app.include_router(items.router, tags=["items"])
app.include_router(sheets_import.router)


@app.get("/health")
def health():
    return {"status": "ok"}


# Serve the compiled React frontend — must come after all API routes
_static = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(_static):
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
