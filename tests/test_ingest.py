import pytest
from sqlmodel import select

from backend.routers import ingest as ingest_mod
from backend.routers import documents as documents_mod
from backend.routers.ingest import _token_from_recipient
from backend.models import UserImportToken, IngestedEmail, PendingChange


SAMPLE_EML = b"""From: Finnair <noreply@finnair.com>
To: import+TESTTOKEN@tripplan.hups.club
Subject: Your booking DYL7CY

Singapore to Helsinki AY132 24.07.2026 21:35
"""

FAKE_PARSED = {"items": [
    {"kind": "flight", "name": "Singapore → Helsinki",
     "details": {"flight_number": "AY132", "depart_time": "2026-07-24T21:35"}},
]}


@pytest.fixture
def ingest_env(monkeypatch, tmp_path):
    monkeypatch.setattr(ingest_mod, "_INGEST_SECRET", "s3cret")
    monkeypatch.setattr(ingest_mod, "_MAIL_STORE", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(documents_mod, "_call_claude", lambda *a, **k: FAKE_PARSED)
    yield


def _post(client, eml=SAMPLE_EML, secret="s3cret", to="import+TESTTOKEN@tripplan.hups.club"):
    return client.post("/ingest/email", content=eml,
                       headers={"X-Ingest-Secret": secret, "X-Original-To": to})


def test_token_from_recipient():
    assert _token_from_recipient("import+abc123@x.com") == "abc123"
    assert _token_from_recipient("import@x.com") == ""
    assert _token_from_recipient("") == ""


def test_ingest_rejects_bad_secret(client, ingest_env):
    assert _post(client, secret="wrong").status_code == 403


def test_ingest_unknown_token_stores_email_no_pending(client, session, ingest_env):
    r = _post(client)  # no matching UserImportToken
    assert r.status_code == 202
    assert r.json()["resolved"] is False
    emails = session.exec(select(IngestedEmail)).all()
    assert len(emails) == 1 and emails[0].status == "error"
    assert emails[0].storage_dir  # raw email was still saved for debugging
    assert session.exec(select(PendingChange)).all() == []


def test_ingest_resolves_user_and_creates_email_pending(client, session, ingest_env):
    session.add(UserImportToken(user_email="dev@local", token="TESTTOKEN"))
    session.commit()
    r = _post(client)
    assert r.status_code == 202
    body = r.json()
    assert body["resolved"] is True and body["items"] == 1

    pcs = session.exec(select(PendingChange)).all()
    assert len(pcs) == 1
    pc = pcs[0]
    assert pc.source == "email"
    assert pc.trip_id is None              # user picks the trip at review
    assert pc.created_by == "dev@local"
    assert pc.payload["details"]["flight_number"] == "AY 132"  # normalised

    em = session.exec(select(IngestedEmail)).all()[0]
    assert em.status == "parsed" and em.item_count == 1
    assert pc.source_email_id == em.id


def test_ingest_reads_token_from_delivered_to_header(client, session, ingest_env):
    """When the pipe passes no X-Original-To, fall back to the email's headers."""
    session.add(UserImportToken(user_email="dev@local", token="HDRTOKEN"))
    session.commit()
    eml = (b"From: x <x@finnair.com>\n"
           b"To: antony@gmail.com\n"
           b"Delivered-To: import+HDRTOKEN@tripplan.hups.club\n"
           b"Subject: booking\n\nAY132 24.07.2026\n")
    r = client.post("/ingest/email", content=eml, headers={"X-Ingest-Secret": "s3cret"})
    assert r.status_code == 202
    assert r.json()["resolved"] is True
    pcs = session.exec(select(PendingChange)).all()
    assert len(pcs) == 1 and pcs[0].created_by == "dev@local"


def test_import_address_is_generated_and_stable(client):
    r = client.get("/me/import-address")
    assert r.status_code == 200
    addr = r.json()["address"]
    assert addr.startswith("import+") and addr.endswith("@tripplan.hups.club")
    assert r.json()["address"] == client.get("/me/import-address").json()["address"]


def test_regenerate_import_address_changes_the_token(client, session):
    original = client.get("/me/import-address").json()["address"]

    r = client.post("/me/import-address/regenerate")
    assert r.status_code == 200
    rotated = r.json()["address"]
    assert rotated.startswith("import+") and rotated.endswith("@tripplan.hups.club")
    assert rotated != original

    # Persisted — a subsequent GET sees the same rotated address, not the original.
    assert client.get("/me/import-address").json()["address"] == rotated

    # Exactly one row for the user (rotation updates in place, doesn't leave a stale row).
    rows = session.exec(select(UserImportToken).where(UserImportToken.user_email == "dev@local")).all()
    assert len(rows) == 1


def test_regenerate_import_address_invalidates_the_old_token(client, session, ingest_env):
    original = client.get("/me/import-address").json()["address"]
    original_token = original.split("+", 1)[1].split("@", 1)[0]

    client.post("/me/import-address/regenerate")

    # A forward to the now-rotated-away token no longer resolves to the user.
    r = _post(client, to=f"import+{original_token}@tripplan.hups.club")
    assert r.status_code == 202
    assert r.json()["resolved"] is False


def test_regenerate_import_address_works_with_no_prior_token(client):
    """A user who never opened Settings (so /me/import-address was never
    called) has no UserImportToken row yet — regenerate should still work,
    not 404/500 on a missing row."""
    r = client.post("/me/import-address/regenerate")
    assert r.status_code == 200
    assert r.json()["address"].startswith("import+")
