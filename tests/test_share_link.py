"""Tests for the revocable public read-only trip share link.

Covers: owner-only management endpoints (create/regenerate/revoke, 403 for
non-owners), the public GET /shared/{token}/timeline endpoint working with
NO auth headers at all, unknown/revoked tokens 404ing, and the public
payload never carrying anything beyond the normal timeline shape.
"""
import pytest

from backend import permissions
from backend.auth import get_current_user
from backend.main import app
from backend.models import TripMembership, TripRole


VIEWER = "viewer@example.com"
EDITOR = "editor@example.com"
OWNER = "dev@local"   # get_current_user's default identity when auth is disabled


@pytest.fixture
def trip(client):
    return client.post("/trips/", json={"name": "Family Trip"}).json()


@pytest.fixture
def as_role(session, trip, monkeypatch):
    """Enable real role checks and let the caller pick which user each
    request runs as, via app.dependency_overrides — same pattern as
    tests/test_attachments.py's as_role fixture."""
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    session.add(TripMembership(trip_id=trip["id"], user_email=VIEWER, role=TripRole.viewer))
    session.add(TripMembership(trip_id=trip["id"], user_email=EDITOR, role=TripRole.editor))
    session.commit()

    def _set(email):
        app.dependency_overrides[get_current_user] = lambda: {"email": email, "name": "", "picture": ""}

    yield _set
    app.dependency_overrides.pop(get_current_user, None)


# ── Owner-gated management endpoints ────────────────────────────────────────

def test_create_share_token_returns_token_and_url(client, trip):
    r = client.post(f"/trips/{trip['id']}/share-token")
    assert r.status_code == 200
    data = r.json()
    assert data["token"]
    assert data["url"] == f"/shared/{data['token']}"


def test_get_share_token_reflects_current_state(client, trip):
    assert client.get(f"/trips/{trip['id']}/share-token").json() == {"token": None, "url": None}

    created = client.post(f"/trips/{trip['id']}/share-token").json()
    fetched = client.get(f"/trips/{trip['id']}/share-token").json()
    assert fetched == created


def test_regenerate_share_token_replaces_and_invalidates_old(client, trip):
    first = client.post(f"/trips/{trip['id']}/share-token").json()["token"]
    second = client.post(f"/trips/{trip['id']}/share-token").json()["token"]
    assert first != second

    assert client.get(f"/shared/{first}/timeline").status_code == 404
    assert client.get(f"/shared/{second}/timeline").status_code == 200


def test_revoke_share_token_disables_the_link(client, trip):
    token = client.post(f"/trips/{trip['id']}/share-token").json()["token"]
    assert client.get(f"/shared/{token}/timeline").status_code == 200

    r = client.delete(f"/trips/{trip['id']}/share-token")
    assert r.status_code == 204
    assert client.get(f"/shared/{token}/timeline").status_code == 404
    assert client.get(f"/trips/{trip['id']}/share-token").json() == {"token": None, "url": None}


def test_non_owner_cannot_create_share_token(client, trip, as_role):
    as_role(EDITOR)
    assert client.post(f"/trips/{trip['id']}/share-token").status_code == 403
    as_role(VIEWER)
    assert client.post(f"/trips/{trip['id']}/share-token").status_code == 403


def test_non_owner_cannot_revoke_share_token(client, trip, as_role):
    as_role(OWNER)
    client.post(f"/trips/{trip['id']}/share-token")
    as_role(EDITOR)
    assert client.delete(f"/trips/{trip['id']}/share-token").status_code == 403


def test_non_owner_cannot_read_share_token_status(client, trip, as_role):
    as_role(EDITOR)
    assert client.get(f"/trips/{trip['id']}/share-token").status_code == 403


# ── Public timeline access ──────────────────────────────────────────────────

def test_public_timeline_accessible_without_auth_headers(client, trip):
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "status": "planned"
    }).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "restaurant", "name": "La Carbonara", "status": "pending"
    })
    token = client.post(f"/trips/{trip['id']}/share-token").json()["token"]

    # No Authorization header at all — and auth is force-enabled so the
    # normal /trips/{id}/timeline route would 401 without one.
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(permissions, "AUTH_ENABLED", True)
        r = client.get(f"/shared/{token}/timeline", headers={})
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "Family Trip"
    assert data["role"] == "viewer"
    assert len(data["stops"]) == 1
    assert data["stops"][0]["items"][0]["name"] == "La Carbonara"


def test_public_timeline_matches_authenticated_timeline_shape(client, trip):
    client.post(f"/trips/{trip['id']}/stops", json={"location": "Rome", "status": "planned"})
    token = client.post(f"/trips/{trip['id']}/share-token").json()["token"]

    normal = client.get(f"/trips/{trip['id']}/timeline").json()
    shared = client.get(f"/shared/{token}/timeline").json()

    # Same keys throughout (role value differs deliberately — see below).
    assert set(shared.keys()) == set(normal.keys())
    for stop_n, stop_s in zip(normal["stops"], shared["stops"]):
        assert set(stop_n.keys()) == set(stop_s.keys())

    shared_no_role = {k: v for k, v in shared.items() if k != "role"}
    normal_no_role = {k: v for k, v in normal.items() if k != "role"}
    assert shared_no_role == normal_no_role
    # The public view is always forced to viewer, regardless of the owner's
    # own role, since it must never carry edit affordances.
    assert shared["role"] == "viewer"


def test_unknown_token_404s(client):
    assert client.get("/shared/not-a-real-token/timeline").status_code == 404


def test_garbage_token_404s(client):
    assert client.get("/shared/" + "x" * 50 + "/timeline").status_code == 404


def test_share_token_never_leaks_into_timeline_payload(client, trip):
    token = client.post(f"/trips/{trip['id']}/share-token").json()["token"]
    data = client.get(f"/shared/{token}/timeline").json()
    assert "share_token" not in data
    assert token not in str(data)


# ── SPA fallback for the bare browser URL ───────────────────────────────────

def test_bare_shared_path_serves_html_not_json(client, trip):
    token = client.post(f"/trips/{trip['id']}/share-token").json()["token"]
    r = client.get(f"/shared/{token}")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
