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

@pytest.mark.parametrize("action", ["get", "delete", "download_file", "delete_file", "list_files", "scan", "holder"])
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
    elif action == "scan":
        r = client.post(f"/me/documents/{doc_id}/files/{file_id}/scan")
    elif action == "holder":
        r = client.get(f"/me/documents/{doc_id}/holder")
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


# ── holder data (name/nationality/DOB/sex) — encrypted, decrypt-on-demand ──

def test_holder_fields_roundtrip_via_patch_and_holder_route(client):
    doc_id = _create(client).json()["id"]
    r = client.patch(f"/me/documents/{doc_id}", json={
        "holder_name": "ANNA MARIA ERIKSSON", "nationality": "UTO",
        "date_of_birth": "1974-08-12", "sex": "F",
    })
    assert r.status_code == 200
    assert "holder_name" not in r.json()

    holder = client.get(f"/me/documents/{doc_id}/holder")
    assert holder.status_code == 200
    assert holder.json() == {
        "holder_name": "ANNA MARIA ERIKSSON", "nationality": "UTO",
        "date_of_birth": "1974-08-12", "sex": "F",
    }


def test_holder_fields_can_be_set_at_creation_time(client):
    # Regression: the frontend's shared add/edit form now includes holder
    # fields in both flows -- if the create route silently dropped them
    # (Pydantic ignores unknown fields by default), holder data typed while
    # adding a new document would vanish instead of being saved.
    r = _create(client, holder_name="ANNA MARIA ERIKSSON", nationality="UTO",
                date_of_birth="1974-08-12", sex="F")
    doc_id = r.json()["id"]
    assert "holder_name" not in r.json()

    holder = client.get(f"/me/documents/{doc_id}/holder")
    assert holder.status_code == 200
    assert holder.json()["holder_name"] == "ANNA MARIA ERIKSSON"
    assert holder.json()["sex"] == "F"


def test_no_holder_data_stored_when_none_provided_at_creation(client):
    doc_id = _create(client).json()["id"]
    assert client.get(f"/me/documents/{doc_id}/holder").status_code == 404


def test_holder_fields_never_in_list_or_detail(client):
    doc_id = _create(client).json()["id"]
    client.patch(f"/me/documents/{doc_id}", json={"holder_name": "Someone"})

    detail = client.get(f"/me/documents/{doc_id}").json()
    assert "holder_name" not in detail
    assert "holder_data_encrypted" not in detail

    listed = client.get("/me/documents").json()[0]
    assert "holder_name" not in listed
    assert "holder_data_encrypted" not in listed


def test_holder_route_404_when_none_stored(client):
    doc_id = _create(client).json()["id"]
    assert client.get(f"/me/documents/{doc_id}/holder").status_code == 404


def test_partial_holder_patch_merges_not_clobbers(client):
    doc_id = _create(client).json()["id"]
    client.patch(f"/me/documents/{doc_id}", json={
        "holder_name": "ANNA MARIA ERIKSSON", "nationality": "UTO",
        "date_of_birth": "1974-08-12", "sex": "F",
    })
    # Only correct one field -- the other three must survive untouched.
    client.patch(f"/me/documents/{doc_id}", json={"sex": "X"})

    holder = client.get(f"/me/documents/{doc_id}/holder").json()
    assert holder == {
        "holder_name": "ANNA MARIA ERIKSSON", "nationality": "UTO",
        "date_of_birth": "1974-08-12", "sex": "X",
    }


def test_503_on_holder_route_when_key_unset(client, monkeypatch):
    doc_id = _create(client).json()["id"]
    client.patch(f"/me/documents/{doc_id}", json={"holder_name": "Someone"})
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    assert client.get(f"/me/documents/{doc_id}/holder").status_code == 503


# ── passport scan (local OCR) ────────────────────────────────────────────────

def test_scan_requires_image_content_type(client):
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id, name="doc.pdf", content=b"%PDF-1.4", ctype="application/pdf").json()["id"]
    r = client.post(f"/me/documents/{doc_id}/files/{file_id}/scan")
    assert r.status_code == 415


def test_scan_503_when_vault_key_unset(client, monkeypatch):
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id).json()["id"]
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    r = client.post(f"/me/documents/{doc_id}/files/{file_id}/scan")
    assert r.status_code == 503


def test_scan_503_when_tesseract_unavailable(client, monkeypatch):
    from backend.routers import vault as vault_mod
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id).json()["id"]
    monkeypatch.setattr(vault_mod.passport_ocr, "tesseract_available", lambda: False)
    r = client.post(f"/me/documents/{doc_id}/files/{file_id}/scan")
    assert r.status_code == 503


def test_scan_422_when_no_mrz_found(client, monkeypatch):
    from backend.routers import vault as vault_mod
    from backend import passport_ocr as passport_ocr_mod
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id).json()["id"]
    monkeypatch.setattr(vault_mod.passport_ocr, "tesseract_available", lambda: True)

    def _raise(content):
        raise passport_ocr_mod.PassportOcrError("no mrz")
    monkeypatch.setattr(vault_mod.passport_ocr, "extract_mrz", _raise)

    r = client.post(f"/me/documents/{doc_id}/files/{file_id}/scan")
    assert r.status_code == 422


def test_scan_returns_extraction_and_does_not_write_to_document(client, monkeypatch):
    from backend.routers import vault as vault_mod
    doc_id = _create(client).json()["id"]
    file_id = _upload(client, doc_id).json()["id"]
    monkeypatch.setattr(vault_mod.passport_ocr, "tesseract_available", lambda: True)

    fake_result = {
        "document_number": "L898902C3", "document_number_valid": True,
        "holder_name": "ANNA MARIA ERIKSSON", "nationality": "UTO",
        "date_of_birth": "1974-08-12", "date_of_birth_valid": True,
        "sex": "F", "issuing_country": "UTO",
        "expiry_date": "2012-04-15", "expiry_date_valid": True,
        "overall_valid": True,
    }
    monkeypatch.setattr(vault_mod.passport_ocr, "extract_mrz", lambda content: fake_result)

    r = client.post(f"/me/documents/{doc_id}/files/{file_id}/scan")
    assert r.status_code == 200
    assert r.json() == fake_result

    # No DB write happened -- the document is unchanged, no holder data stored.
    detail = client.get(f"/me/documents/{doc_id}").json()
    assert detail["label"] == "US Passport"
    assert client.get(f"/me/documents/{doc_id}/holder").status_code == 404
