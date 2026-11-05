"""/health: the fleet-spec OBS-1 contract (see docs/fleet-spec in hamBank/fleetSpec).

backend_sha  - HEAD of the running backend checkout
build_sha    - HEAD the frontend bundle was built from (static/version.json)
frontend_sha - last commit that touched the frontend; the stale-client reload key
sha          - deprecated alias of frontend_sha (already-deployed bundles read it)
"""
import json

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.database import get_session


@pytest.fixture
def version(monkeypatch):
    data = {"build_sha": "bbb2222", "frontend_sha": "fff1111", "built_at": "2026-11-05T00:00:00+00:00"}
    monkeypatch.setattr(main, "_read_version", lambda: data)
    return data


def test_health_reports_the_full_contract(client: TestClient, version):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["frontend_sha"] == "fff1111"
    assert body["build_sha"] == "bbb2222"
    assert body["built_at"] == "2026-11-05T00:00:00+00:00"
    assert body["backend_sha"] == main._BACKEND_SHA
    assert body["started_at"] == main._STARTED_AT
    assert isinstance(body["data_version"], int)


def test_sha_is_an_alias_of_frontend_sha(client: TestClient, version):
    body = client.get("/health").json()
    assert body["sha"] == body["frontend_sha"] == "fff1111"


def test_without_version_json_build_sha_is_null_and_frontend_sha_falls_back(client: TestClient, monkeypatch):
    monkeypatch.setattr(main, "_read_version", lambda: {})
    monkeypatch.setattr(main, "_frontend_sha", lambda: "legacy1")
    body = client.get("/health").json()
    assert body["build_sha"] is None
    assert body["built_at"] is None
    assert body["frontend_sha"] == body["sha"] == "legacy1"


def test_read_version_reads_the_file_fresh_each_call(tmp_path, monkeypatch):
    # The deploy restarts the service before the frontend build finishes, so
    # the value must never be cached at startup.
    static = tmp_path / "static"
    static.mkdir()
    monkeypatch.setattr(main, "__file__", str(tmp_path / "main.py"))
    assert main._read_version() == {}

    (static / "version.json").write_text(json.dumps({"build_sha": "one"}))
    assert main._read_version() == {"build_sha": "one"}

    (static / "version.json").write_text(json.dumps({"build_sha": "two"}))
    assert main._read_version() == {"build_sha": "two"}


def test_read_version_tolerates_garbage(tmp_path, monkeypatch):
    (tmp_path / "static").mkdir()
    monkeypatch.setattr(main, "__file__", str(tmp_path / "main.py"))
    (tmp_path / "static" / "version.json").write_text("not json")
    assert main._read_version() == {}
    (tmp_path / "static" / "version.json").write_text("[1, 2]")
    assert main._read_version() == {}


def test_health_is_503_when_the_database_is_unreachable(client: TestClient, version):
    class _BrokenSession:
        def exec(self, *a, **k):
            raise RuntimeError("connection refused")

    main.app.dependency_overrides[get_session] = lambda: _BrokenSession()
    r = client.get("/health")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "error"
    assert body["backend_sha"] == main._BACKEND_SHA  # still says what is running
