"""Plan 11 step 2: compare-and-set `base` on the item/stop/packing PATCH
endpoints, used by the frontend offline queue to replay ops safely.
"""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def trip(client: TestClient):
    return client.post("/trips/", json={"name": "Test Trip"}).json()


@pytest.fixture
def stop(client: TestClient, trip):
    return client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "status": "planned"
    }).json()


@pytest.fixture
def item(client: TestClient, stop):
    return client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Pantheon", "status": "pending",
        "notes": "bring water", "details": {"foo": "bar"},
    }).json()


# ── Items: scalar fields ─────────────────────────────────────────────────────

def test_item_replay_applies_when_unchanged_since_base(client: TestClient, item):
    r = client.patch(f"/items/{item['id']}", json={
        "status": "done", "base": {"status": "pending"},
    })
    assert r.status_code == 200
    assert r.json()["status"] == "done"


def test_item_replay_is_idempotent_when_already_applied(client: TestClient, item):
    client.patch(f"/items/{item['id']}", json={"status": "done", "base": {"status": "pending"}})
    # Replayed a second time (duplicate flush) — current == incoming, no conflict.
    r = client.patch(f"/items/{item['id']}", json={"status": "done", "base": {"status": "pending"}})
    assert r.status_code == 200
    assert r.json()["status"] == "done"


def test_item_replay_conflicts_on_real_concurrent_edit(client: TestClient, item):
    # Someone else changed status to "skipped" after the client's base snapshot.
    client.patch(f"/items/{item['id']}", json={"status": "skipped"})
    r = client.patch(f"/items/{item['id']}", json={
        "status": "done", "base": {"status": "pending"},
    })
    assert r.status_code == 409
    body = r.json()["detail"]
    assert body["conflicts"] == [{"field": "status", "base": "pending", "server": "skipped", "mine": "done"}]
    assert body["current"]["status"] == "skipped"
    # Nothing applied from a conflicting op.
    assert client.get(f"/items/{item['id']}").json()["status"] == "skipped"


def test_item_field_with_no_base_entry_applies_directly(client: TestClient, item):
    r = client.patch(f"/items/{item['id']}", json={
        "notes": "new notes", "base": {},
    })
    assert r.status_code == 200
    assert r.json()["notes"] == "new notes"


# ── Items: `details` key-level merge ─────────────────────────────────────────

def test_item_details_disjoint_keys_auto_merge(client: TestClient, item):
    # Simulate a concurrent edit to a different details key.
    client.patch(f"/items/{item['id']}", json={"details": {"foo": "bar", "other": "concurrent"}})
    r = client.patch(f"/items/{item['id']}", json={
        "details": {"foo": "mine"},
        "base": {"details": {"foo": "bar"}},
    })
    assert r.status_code == 200
    assert r.json()["details"] == {"foo": "mine", "other": "concurrent"}


def test_item_details_same_key_conflict(client: TestClient, item):
    client.patch(f"/items/{item['id']}", json={"details": {"foo": "server-value"}})
    r = client.patch(f"/items/{item['id']}", json={
        "details": {"foo": "my-value"},
        "base": {"details": {"foo": "bar"}},
    })
    assert r.status_code == 409
    conflicts = r.json()["detail"]["conflicts"]
    assert conflicts == [{"field": "details.foo", "base": "bar", "server": "server-value", "mine": "my-value"}]


def test_item_no_base_request_unchanged_wholesale_semantics(client: TestClient, item):
    # No `base` at all — the pre-existing online behaviour: details replaced wholesale.
    r = client.patch(f"/items/{item['id']}", json={"details": {"only": "this"}})
    assert r.status_code == 200
    assert r.json()["details"] == {"only": "this"}


def test_item_replay_records_history_with_offline_sync_source(client: TestClient, item):
    client.patch(f"/items/{item['id']}", json={"status": "done", "base": {"status": "pending"}})
    history = client.get(f"/items/{item['id']}/history").json()
    assert history[0]["source"] == "offline-sync"


def test_item_online_update_records_history_with_empty_source(client: TestClient, item):
    client.patch(f"/items/{item['id']}", json={"status": "done"})
    history = client.get(f"/items/{item['id']}/history").json()
    assert history[0]["source"] == ""


# ── Stops ────────────────────────────────────────────────────────────────────

def test_stop_replay_applies_and_conflicts(client: TestClient, stop):
    r = client.patch(f"/stops/{stop['id']}", json={
        "status": "confirmed", "base": {"status": "planned"},
    })
    assert r.status_code == 200
    assert r.json()["status"] == "confirmed"

    # Someone else moves it to "completed" before the next replay.
    client.patch(f"/stops/{stop['id']}", json={"status": "completed"})
    r = client.patch(f"/stops/{stop['id']}", json={
        "status": "confirmed", "base": {"status": "planned"},
    })
    assert r.status_code == 409
    assert r.json()["detail"]["conflicts"][0]["field"] == "status"


def test_stop_replay_idempotent(client: TestClient, stop):
    client.patch(f"/stops/{stop['id']}", json={"status": "confirmed", "base": {"status": "planned"}})
    r = client.patch(f"/stops/{stop['id']}", json={"status": "confirmed", "base": {"status": "planned"}})
    assert r.status_code == 200
    assert r.json()["status"] == "confirmed"


# ── Packing items ────────────────────────────────────────────────────────────

@pytest.fixture
def pack_item(client: TestClient, trip):
    return client.post(f"/trips/{trip['id']}/packing", json={
        "name": "Sunscreen", "quantity": 2, "packed_count": 0,
    }).json()


def test_packing_replay_disjoint_fields_auto_merge(client: TestClient, pack_item):
    # Partner renames the item while I check it off offline.
    client.patch(f"/packing/{pack_item['id']}", json={"name": "Sunscreen SPF50"})
    r = client.patch(f"/packing/{pack_item['id']}", json={
        "packed_count": 2, "base": {"packed_count": 0},
    })
    assert r.status_code == 200
    body = r.json()
    assert body["packed_count"] == 2
    assert body["name"] == "Sunscreen SPF50"


def test_packing_replay_conflicts_on_same_field(client: TestClient, pack_item):
    client.patch(f"/packing/{pack_item['id']}", json={"packed_count": 1})
    r = client.patch(f"/packing/{pack_item['id']}", json={
        "packed_count": 2, "base": {"packed_count": 0},
    })
    assert r.status_code == 409
    assert r.json()["detail"]["conflicts"][0] == {
        "field": "packed_count", "base": 0, "server": 1, "mine": 2,
    }


def test_packing_replay_idempotent(client: TestClient, pack_item):
    client.patch(f"/packing/{pack_item['id']}", json={"packed_count": 2, "base": {"packed_count": 0}})
    r = client.patch(f"/packing/{pack_item['id']}", json={"packed_count": 2, "base": {"packed_count": 0}})
    assert r.status_code == 200
    assert r.json()["packed_count"] == 2
