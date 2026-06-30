"""Tests for the data_version field in /health — changes on any DB write.

data_version backs the cross-device sync poller: clients compare it against the
last value they saw and silently refresh when it changes. The contract is:
  * present, integer, > 0
  * strictly increases after a write
  * stable across reads with no intervening write

It must NOT depend on the database being a file on disk (Postgres has none), so
these run on the in-memory SQLite test engine with no travel.db present.
"""


def test_health_includes_data_version(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert "data_version" in body
    assert isinstance(body["data_version"], int)
    assert body["data_version"] > 0


def test_data_version_strictly_increases_after_write(client):
    v1 = client.get("/health").json()["data_version"]

    r = client.post("/trips/", json={"name": "Version test trip"})
    assert r.status_code in (200, 201)

    v2 = client.get("/health").json()["data_version"]
    assert v2 > v1, "data_version must strictly increase after a write"


def test_data_version_advances_once_per_write(client):
    v1 = client.get("/health").json()["data_version"]
    client.post("/trips/", json={"name": "trip A"})
    v2 = client.get("/health").json()["data_version"]
    client.post("/trips/", json={"name": "trip B"})
    v3 = client.get("/health").json()["data_version"]
    assert v3 > v2 > v1


def test_data_version_is_stable_without_writes(client):
    v1 = client.get("/health").json()["data_version"]
    v2 = client.get("/health").json()["data_version"]
    assert v1 == v2
