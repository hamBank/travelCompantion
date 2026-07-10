import pytest
from fastapi.testclient import TestClient
from sqlmodel import create_engine, Session, SQLModel
from sqlmodel.pool import StaticPool

from backend.main import app
from backend.database import get_session
from backend import database as database_mod

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
