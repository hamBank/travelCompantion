import pytest
from fastapi.testclient import TestClient
from sqlmodel import create_engine, Session, SQLModel
from sqlmodel.pool import StaticPool

from backend.main import app
from backend.database import get_session
from backend import database as database_mod
from backend import flight_live, flight_alert_subscriptions

# The Postgres CI job (.github/workflows/ci.yml) points DATABASE_URL at a
# real Postgres service so the suite exercises JSON/enum/datetime dialect
# behavior sqlite can't catch (see docs/postgres-migration.md). Every test
# session is built via make_test_session() below rather than a hardcoded
# sqlite engine, so this one env var switches the whole suite's backend —
# same fixtures, same tests, different engine underneath.
_USE_POSTGRES = database_mod.DATABASE_URL.startswith("postgresql")


def make_test_session() -> Session:
    """A fresh, isolated SQLModel Session for one test.

    Sqlite (the default, and CI's primary/fast job): a brand-new in-memory
    database per call — free isolation, nothing to clean up.
    Postgres (CI's slower dialect-accuracy job): the real, persistent
    database from DATABASE_URL — there's no equivalent "fresh in-memory"
    option, so the schema is dropped and rebuilt before each test instead,
    for the same "every test starts empty" guarantee.
    """
    if _USE_POSTGRES:
        engine = database_mod.engine
        SQLModel.metadata.drop_all(engine)
        SQLModel.metadata.create_all(engine)
        return Session(engine)

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


@pytest.fixture(autouse=True)
def _no_real_rate_limit_sleeps(monkeypatch):
    """backend/rate_limit.py's throttle() protects the real AeroDataBox API
    from a per-second cap (see backend/flight_live.py, backend/
    flight_alert_subscriptions.py) — tests fake the HTTP layer already, so a
    real sleep() here only slows the suite (confirmed: ~1.2s x every
    test_flight_check.py test with no fix). backend/rate_limit.py's own tests
    import throttle directly and are unaffected — this only patches the two
    consumer modules' bound reference."""
    monkeypatch.setattr(flight_live, "throttle", lambda *a, **k: None)
    monkeypatch.setattr(flight_alert_subscriptions, "throttle", lambda *a, **k: None)


@pytest.fixture(name="session")
def session_fixture():
    with make_test_session() as session:
        yield session


@pytest.fixture(name="client")
def client_fixture(session: Session):
    def get_session_override():
        yield session

    app.dependency_overrides[get_session] = get_session_override
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()
