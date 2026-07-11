"""Tests for the document vault (backend-only CRUD, plan-12a) — encrypted
passport/licence/visa scans, owner-only, never trip-scoped.

Modeled on tests/test_attachments.py for the upload/size/count-cap shape and
on the newest cascade-delete tests in tests/test_trips.py / test_stops.py
(issue #68's Postgres CI work) for the delete-flush-ordering shape.
"""
import io

import pytest

from backend import document_crypto
from backend.auth import get_current_user
from backend.main import app

OWNER = "dev@local"   # AUTH_ENABLED is off in tests, so get_current_user always
                        # returns this — matches backend/auth.py's dev fallback.
OTHER = "other@example.com"


@pytest.fixture(autouse=True)
def _vault_key(monkeypatch):
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "zzc1BvE6r16LzTX2WeXAyIfYP4bpFqQPzTU-JBBjfk8=")


def _create(client, **overrides):
    body = {"doc_type": "passport", "label": "US Passport", "country": "US"}
    body.update(overrides)
    return client.post("/me/documents", json=body)


def _upload(client, doc_id, name="passport.jpg", content=b"\xff\xd8\xff fake jpeg bytes", ctype="image/jpeg"):
    return client.post(f"/me/documents/{doc_id}/files", files={"file": (name, io.BytesIO(content), ctype)})


def _as(email):
    app.dependency_overrides[get_current_user] = lambda: {"email": email, "name": "", "picture": ""}


@pytest.fixture(autouse=True)
def _default_user():
    _as(OWNER)
    yield
    app.dependency_overrides.pop(get_current_user, None)


# ── CRUD round-trip ──────────────────────────────────────────────────────────

def test_create_list_edit_delete_roundtrip(client):
    r = _create(client)
    assert r.status_code == 201
    doc = r.json()
    assert doc["doc_type"] == "passport"
    assert doc["label"] == "US Passport"
    assert "document_number_encrypted" not in doc

    listing = client.get("/me/documents").json()
    assert len(listing) == 1
    assert listing[0]["id"] == doc["id"]

    edited = client.patch(f"/me/documents/{doc['id']}", json={"label": "Renewed Passport"})
    assert edited.status_code == 200
    assert edited.json()["label"] == "Renewed Passport"

    assert client.delete(f"/me/documents/{doc['id']}").status_code == 204
    assert client.get(f"/me/documents/{doc['id']}").status_code == 404
    assert client.get("/me/documents").json() == []


# ── file round-trip: byte-identical after encrypt -> store -> fetch -> decrypt

def test_uploaded_file_bytes_are_byte_identical_after_roundtrip(client):
    doc_id = _create(client).json()["id"]
    content = b"\xff\xd8\xff\xe0 not really a jpeg but exercises binary bytes \x00\x01\x02"
    r = _upload(client, doc_id, content=content)
    assert r.status_code == 201
    file_id = r.json()["id"]
    assert "data_encrypted" not in r.json()

    dl = client.get(f"/me/documents/{doc_id}/files/{file_id}")
    assert dl.status_code == 200
    assert dl.content == content
    assert dl.headers["content-type"] == "image/jpeg"
    assert "passport.jpg" in dl.headers["content-disposition"]


def test_deleting_document_deletes_its_files(client):
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id).json()["id"]
    assert client.delete(f"/me/documents/{doc_id}").status_code == 204
    assert client.get(f"/me/documents/{doc_id}/files/{file_id}").status_code == 404


# ── document_number is encrypted, never leaks into list/detail ─────────────

def test_document_number_never_in_list_or_detail_only_via_number_route(client):
    doc = _create(client, document_number="X1234567").json()
    assert "document_number" not in doc
    assert "document_number_encrypted" not in doc

    listed = client.get("/me/documents").json()[0]
    assert "document_number" not in listed
    assert "document_number_encrypted" not in listed

    detail = client.get(f"/me/documents/{doc['id']}").json()
    assert "document_number" not in detail

    number = client.get(f"/me/documents/{doc['id']}/number")
    assert number.status_code == 200
    assert number.json()["document_number"] == "X1234567"


def test_number_route_404_when_none_stored(client):
    doc_id = _create(client).json()["id"]
    assert client.get(f"/me/documents/{doc_id}/number").status_code == 404


def test_updating_document_number_reencrypts(client):
    doc_id = _create(client, document_number="X1111111").json()["id"]
    client.patch(f"/me/documents/{doc_id}", json={"document_number": "X2222222"})
    assert client.get(f"/me/documents/{doc_id}/number").json()["document_number"] == "X2222222"


# ── cross-user isolation (security-critical) ────────────────────────────────

@pytest.mark.parametrize("action", ["get", "delete", "download_file", "delete_file", "list_files"])
def test_cross_user_isolation_404s_not_leaks(client, action):
    _as(OWNER)
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id).json()["id"]

    _as(OTHER)
    if action == "get":
        r = client.get(f"/me/documents/{doc_id}")
    elif action == "delete":
        r = client.delete(f"/me/documents/{doc_id}")
    elif action == "download_file":
        r = client.get(f"/me/documents/{doc_id}/files/{file_id}")
    elif action == "list_files":
        r = client.get(f"/me/documents/{doc_id}/files")
    else:
        r = client.delete(f"/me/documents/{doc_id}/files/{file_id}")
    assert r.status_code == 404


# ── listing a document's files ──────────────────────────────────────────────

def test_list_document_files_metadata_only(client):
    doc_id = _create(client).json()["id"]
    f1 = _upload(client, doc_id, name="front.jpg").json()["id"]
    f2 = _upload(client, doc_id, name="back.jpg").json()["id"]

    listed = client.get(f"/me/documents/{doc_id}/files").json()
    assert {f["id"] for f in listed} == {f1, f2}
    assert all("data_encrypted" not in f for f in listed)


def test_cross_user_list_never_shows_others_documents(client):
    _as(OWNER)
    _create(client)

    _as(OTHER)
    assert client.get("/me/documents").json() == []


# ── 503 when DOCUMENT_ENCRYPTION_KEY is unset ───────────────────────────────

def test_503_on_create_when_key_unset(client, monkeypatch):
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    r = _create(client)
    assert r.status_code == 503


def test_503_on_upload_and_download_when_key_unset(client, monkeypatch):
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id).json()["id"]

    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    assert _upload(client, doc_id).status_code == 503
    assert client.get(f"/me/documents/{doc_id}/files/{file_id}").status_code == 503


def test_503_on_number_route_when_key_unset(client, monkeypatch):
    doc_id = _create(client, document_number="X1234567").json()["id"]
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    assert client.get(f"/me/documents/{doc_id}/number").status_code == 503


def test_list_get_delete_still_work_when_key_unset(client, monkeypatch):
    """Metadata-only routes never touch encrypt/decrypt, so they still work
    even with the key unset -- create is the one route that always 503s
    uniformly (see backend/routers/vault.py's _require_vault_configured)."""
    doc_id = _create(client).json()["id"]
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    assert client.get("/me/documents").status_code == 200
    assert client.get(f"/me/documents/{doc_id}").status_code == 200
    assert client.delete(f"/me/documents/{doc_id}").status_code == 204


# ── size / count caps ────────────────────────────────────────────────────────

def test_file_too_large_rejected(client):
    doc_id = _create(client).json()["id"]
    big = b"x" * (10 * 1024 * 1024 + 1)
    r = _upload(client, doc_id, content=big)
    assert r.status_code == 413


def test_max_ten_files_per_document(client):
    doc_id = _create(client).json()["id"]
    for i in range(10):
        r = _upload(client, doc_id, name=f"page{i}.jpg", content=f"page {i}".encode())
        assert r.status_code == 201
    r = _upload(client, doc_id, name="page11.jpg", content=b"eleventh")
    assert r.status_code == 400
