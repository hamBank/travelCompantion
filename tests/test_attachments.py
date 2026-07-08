"""Tests for item attachments (boarding passes, booking PDFs, QR codes) —
upload/list/download/delete, the size and count caps, 404s, and role
enforcement (viewer can download but not upload/delete)."""
import io

import pytest

from backend import permissions
from backend.auth import get_current_user
from backend.main import app
from backend.models import TripMembership, TripRole
from backend.routers import attachments as attachments_mod


@pytest.fixture
def item(client):
    trip = client.post("/trips/", json={"name": "Attachments Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Airport", "status": "planned"
    }).json()
    itm = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "SYD-LHR", "status": "pending",
    }).json()
    itm["trip_id"] = trip["id"]
    return itm


def _upload(client, item_id, name="boarding-pass.pdf", content=b"%PDF-1.4 fake pdf bytes", ctype="application/pdf"):
    return client.post(
        f"/items/{item_id}/attachments",
        files={"file": (name, io.BytesIO(content), ctype)},
    )


# ── happy path: upload -> list -> download -> delete ────────────────────────

def test_upload_list_download_roundtrip(client, item):
    content = b"%PDF-1.4 the actual bytes of a boarding pass"
    r = _upload(client, item["id"], content=content)
    assert r.status_code == 201
    body = r.json()
    assert body["filename"] == "boarding-pass.pdf"
    assert body["content_type"] == "application/pdf"
    assert body["size"] == len(content)
    assert "data" not in body   # never shipped in the create response either
    att_id = body["id"]

    listing = client.get(f"/items/{item['id']}/attachments").json()
    assert len(listing) == 1
    assert listing[0]["id"] == att_id
    assert listing[0]["filename"] == "boarding-pass.pdf"
    assert "data" not in listing[0]

    dl = client.get(f"/attachments/{att_id}")
    assert dl.status_code == 200
    assert dl.content == content
    assert dl.headers["content-type"] == "application/pdf"
    assert "boarding-pass.pdf" in dl.headers["content-disposition"]

    d = client.delete(f"/attachments/{att_id}")
    assert d.status_code == 204
    assert client.get(f"/items/{item['id']}/attachments").json() == []
    assert client.get(f"/attachments/{att_id}").status_code == 404


# ── caps ─────────────────────────────────────────────────────────────────────

def test_upload_over_10mb_returns_413(client, item, monkeypatch):
    # Shrink the cap instead of actually generating 10MB+ of bytes.
    monkeypatch.setattr(attachments_mod, "_MAX_SIZE", 10)
    r = _upload(client, item["id"], content=b"x" * 11)
    assert r.status_code == 413


def test_11th_attachment_returns_400(client, item, monkeypatch):
    monkeypatch.setattr(attachments_mod, "_MAX_COUNT", 3)
    for i in range(3):
        assert _upload(client, item["id"], name=f"f{i}.pdf").status_code == 201
    r = _upload(client, item["id"], name="one-too-many.pdf")
    assert r.status_code == 400


# ── 404s ─────────────────────────────────────────────────────────────────────

def test_upload_404s_for_missing_item(client):
    assert _upload(client, 999999).status_code == 404


def test_list_404s_for_missing_item(client):
    assert client.get("/items/999999/attachments").status_code == 404


def test_download_404s_for_missing_attachment(client):
    assert client.get("/attachments/999999").status_code == 404


def test_delete_404s_for_missing_attachment(client):
    assert client.delete("/attachments/999999").status_code == 404


# ── deleting the item cascades to its attachments ───────────────────────────

def test_deleting_item_deletes_its_attachments(client, item):
    att_id = _upload(client, item["id"]).json()["id"]
    assert client.delete(f"/items/{item['id']}").status_code == 204
    assert client.get(f"/attachments/{att_id}").status_code == 404


# ── role enforcement (viewer can download, cannot upload/delete) ───────────

VIEWER = "viewer@example.com"
EDITOR = "editor@example.com"


@pytest.fixture
def as_role(session, item, monkeypatch):
    """Enable real role checks and let the caller pick which user each
    request runs as, via app.dependency_overrides."""
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    session.add(TripMembership(trip_id=item["trip_id"], user_email=VIEWER, role=TripRole.viewer))
    session.add(TripMembership(trip_id=item["trip_id"], user_email=EDITOR, role=TripRole.editor))
    session.commit()

    def _set(email):
        app.dependency_overrides[get_current_user] = lambda: {"email": email, "name": "", "picture": ""}

    yield _set
    app.dependency_overrides.pop(get_current_user, None)


def test_viewer_cannot_upload(client, item, as_role):
    as_role(EDITOR)
    att_id = _upload(client, item["id"]).json()["id"]

    as_role(VIEWER)
    r = _upload(client, item["id"], name="not-allowed.pdf")
    assert r.status_code == 403

    # ...but a viewer CAN download the attachment an editor already uploaded.
    dl = client.get(f"/attachments/{att_id}")
    assert dl.status_code == 200


def test_viewer_cannot_delete(client, item, as_role):
    as_role(EDITOR)
    att_id = _upload(client, item["id"]).json()["id"]

    as_role(VIEWER)
    assert client.delete(f"/attachments/{att_id}").status_code == 403
