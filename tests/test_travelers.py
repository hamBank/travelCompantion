"""Tests for Traveler (plan 17a) — model helpers, the D4 permission matrix,
the encrypted profile, the D8 passport_expiry date warning, and the D9
delete-trip cascade.

Modeled on tests/test_vault.py for the encryption-key fixture/monkeypatch
pattern and tests/test_expenses.py's test_viewer_cannot_create_expense for
how a second/third user's role is simulated (flip AUTH_ENABLED on, add
TripMembership rows, mint a real JWT via auth.create_jwt).
"""
import importlib.util
import os
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend import auth, document_crypto, permissions
from backend import travelers as travelers_mod
from backend.models import Trip, TripMembership, TripRole, Traveler

OWNER = "owner@example.com"
EDITOR = "editor@example.com"
VIEWER = "viewer@example.com"
OUTSIDER = "outsider@example.com"

_KEY = "zzc1BvE6r16LzTX2WeXAyIfYP4bpFqQPzTU-JBBjfk8="


@pytest.fixture(autouse=True)
def _vault_key(monkeypatch):
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", _KEY)


def _headers(email: str) -> dict:
    return {"Authorization": f"Bearer {auth.create_jwt({'email': email})}"}


@pytest.fixture
def real_auth(monkeypatch):
    """Flip on real, membership-scoped auth so owner/editor/viewer actually
    differ — by default (auth disabled) every request is dev@local-as-owner,
    same pattern as test_expenses.py's test_viewer_cannot_create_expense."""
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)


@pytest.fixture
def trip_id(session: Session, real_auth) -> int:
    """A trip with OWNER/EDITOR/VIEWER members, per the D4 matrix under test."""
    trip = Trip(name="Family Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(TripMembership(trip_id=trip.id, user_email=OWNER, role=TripRole.owner))
    session.add(TripMembership(trip_id=trip.id, user_email=EDITOR, role=TripRole.editor))
    session.add(TripMembership(trip_id=trip.id, user_email=VIEWER, role=TripRole.viewer))
    session.commit()
    return trip.id


def _create(client: TestClient, trip_id: int, actor: str, **body):
    body.setdefault("display_name", "Test Traveler")
    return client.post(f"/trips/{trip_id}/travelers", json=body, headers=_headers(actor))


# ── unit tests: backend/travelers.py ───────────────────────────────────────

def test_age_at_before_birthday_in_year():
    assert travelers_mod.age_at(date(1990, 6, 15), date(2020, 6, 14)) == 29


def test_age_at_on_and_after_birthday_in_year():
    assert travelers_mod.age_at(date(1990, 6, 15), date(2020, 6, 15)) == 30
    assert travelers_mod.age_at(date(1990, 6, 15), date(2020, 6, 16)) == 30


def test_age_at_leap_day_dob_not_yet_had_birthday():
    # Feb 29 2000 DOB, evaluated the day before Feb 29 "would" fall (a
    # non-leap year has no Feb 29 — the birthday hasn't happened yet by Feb 28).
    assert travelers_mod.age_at(date(2000, 2, 29), date(2001, 2, 28)) == 0


def test_age_at_leap_day_dob_counts_birthday_on_march_1_in_non_leap_year():
    assert travelers_mod.age_at(date(2000, 2, 29), date(2001, 3, 1)) == 1


def test_age_band_boundaries():
    on = date(2020, 1, 1)
    assert travelers_mod.age_band(date(2018, 1, 2), on) == "infant"   # 1y364d
    assert travelers_mod.age_band(date(2018, 1, 1), on) == "child"    # exactly 2y
    assert travelers_mod.age_band(date(2009, 1, 1), on) == "child"    # 11y
    assert travelers_mod.age_band(date(2008, 1, 1), on) == "adult"    # exactly 12y


def test_encode_profile_drops_unknown_keys():
    blob = travelers_mod.encode_profile({"full_name": "A B", "unknown_field": "x", "notes": "n"})
    decoded = travelers_mod.decode_profile(blob)
    assert decoded == {"full_name": "A B", "notes": "n"}


def test_encode_decode_profile_roundtrip():
    data = {"full_name": "A", "phone": "555-1234", "frequent_flyer": [{"airline": "QF", "number": "123"}]}
    assert travelers_mod.decode_profile(travelers_mod.encode_profile(data)) == data


def test_decode_profile_raises_when_key_unset(monkeypatch):
    blob = travelers_mod.encode_profile({"full_name": "A"})
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    with pytest.raises(document_crypto.DocumentVaultNotConfigured):
        travelers_mod.decode_profile(blob)


def test_trip_ids_traveled_by_counts_traveler_rows_not_membership(session: Session):
    t1, t2 = Trip(name="T1"), Trip(name="T2")
    session.add(t1)
    session.add(t2)
    session.commit()
    session.refresh(t1)
    session.refresh(t2)
    # Traveler on t1 only.
    session.add(Traveler(trip_id=t1.id, user_email="a@example.com", display_name="A"))
    # Member (not traveler) on t2 — must NOT count.
    session.add(TripMembership(trip_id=t2.id, user_email="a@example.com", role=TripRole.viewer))
    session.commit()

    assert travelers_mod.trip_ids_traveled_by(session, "A@Example.com") == {t1.id}


# ── permission matrix: owner ────────────────────────────────────────────────

def test_owner_can_create_with_and_without_user_email(client: TestClient, trip_id):
    r1 = _create(client, trip_id, OWNER, display_name="Kid", user_email="kid@example.com")
    assert r1.status_code == 201
    assert r1.json()["user_email"] == "kid@example.com"

    r2 = _create(client, trip_id, OWNER, display_name="No Account")
    assert r2.status_code == 201
    assert r2.json()["user_email"] is None


def test_owner_can_list_patch_delete_any(client: TestClient, trip_id):
    tid = _create(client, trip_id, EDITOR).json()["id"]   # editor creates own entry

    listed = client.get(f"/trips/{trip_id}/travelers", headers=_headers(OWNER)).json()
    assert any(t["id"] == tid for t in listed)

    patched = client.patch(f"/trips/{trip_id}/travelers/{tid}", json={"display_name": "Renamed"}, headers=_headers(OWNER))
    assert patched.status_code == 200
    assert patched.json()["display_name"] == "Renamed"

    assert client.delete(f"/trips/{trip_id}/travelers/{tid}", headers=_headers(OWNER)).status_code == 204


def test_owner_can_read_and_put_any_profile(client: TestClient, trip_id):
    tid = _create(client, trip_id, EDITOR).json()["id"]

    put = client.put(f"/trips/{trip_id}/travelers/{tid}/profile", json={"full_name": "Ed Itor"}, headers=_headers(OWNER))
    assert put.status_code == 200
    assert put.json()["full_name"] == "Ed Itor"

    got = client.get(f"/trips/{trip_id}/travelers/{tid}/profile", headers=_headers(OWNER))
    assert got.status_code == 200
    assert got.json()["full_name"] == "Ed Itor"


# ── permission matrix: editor ───────────────────────────────────────────────

def test_editor_create_forces_user_email_to_self(client: TestClient, trip_id):
    r = _create(client, trip_id, EDITOR, user_email="someone-else@example.com")
    assert r.status_code == 201
    assert r.json()["user_email"] == EDITOR


def test_editor_second_create_conflicts(client: TestClient, trip_id):
    assert _create(client, trip_id, EDITOR).status_code == 201
    assert _create(client, trip_id, EDITOR).status_code == 409


def test_editor_patch_own_ok_other_403(client: TestClient, trip_id):
    own_id = _create(client, trip_id, EDITOR).json()["id"]
    other_id = _create(client, trip_id, OWNER, display_name="Other", user_email=None).json()["id"]

    ok = client.patch(f"/trips/{trip_id}/travelers/{own_id}", json={"display_name": "Me"}, headers=_headers(EDITOR))
    assert ok.status_code == 200

    forbidden = client.patch(f"/trips/{trip_id}/travelers/{other_id}", json={"display_name": "Nope"}, headers=_headers(EDITOR))
    assert forbidden.status_code == 403


def test_editor_patch_own_with_different_user_email_403(client: TestClient, trip_id):
    own_id = _create(client, trip_id, EDITOR).json()["id"]
    r = client.patch(
        f"/trips/{trip_id}/travelers/{own_id}", json={"user_email": "hijack@example.com"}, headers=_headers(EDITOR)
    )
    assert r.status_code == 403


def test_editor_delete_own_ok_other_403(client: TestClient, trip_id):
    own_id = _create(client, trip_id, EDITOR).json()["id"]
    other_id = _create(client, trip_id, OWNER, display_name="Other", user_email=None).json()["id"]

    assert client.delete(f"/trips/{trip_id}/travelers/{other_id}", headers=_headers(EDITOR)).status_code == 403
    assert client.delete(f"/trips/{trip_id}/travelers/{own_id}", headers=_headers(EDITOR)).status_code == 204


def test_editor_profile_read_and_put_own_ok_other_403(client: TestClient, trip_id):
    own_id = _create(client, trip_id, EDITOR).json()["id"]
    other_id = _create(client, trip_id, OWNER, display_name="Other", user_email=None).json()["id"]

    put_own = client.put(f"/trips/{trip_id}/travelers/{own_id}/profile", json={"full_name": "Me"}, headers=_headers(EDITOR))
    assert put_own.status_code == 200
    read_own = client.get(f"/trips/{trip_id}/travelers/{own_id}/profile", headers=_headers(EDITOR))
    assert read_own.status_code == 200

    put_other = client.put(f"/trips/{trip_id}/travelers/{other_id}/profile", json={"full_name": "Nope"}, headers=_headers(EDITOR))
    assert put_other.status_code == 403
    read_other = client.get(f"/trips/{trip_id}/travelers/{other_id}/profile", headers=_headers(EDITOR))
    assert read_other.status_code == 403


# ── permission matrix: viewer ───────────────────────────────────────────────

def test_viewer_list_ok_no_encrypted_content_at_all(client: TestClient, trip_id):
    tid = _create(client, trip_id, OWNER, display_name="Kid", user_email=None).json()["id"]
    client.put(f"/trips/{trip_id}/travelers/{tid}/profile", json={"full_name": "Secret Name"}, headers=_headers(OWNER))

    listed = client.get(f"/trips/{trip_id}/travelers", headers=_headers(VIEWER))
    assert listed.status_code == 200
    body = listed.json()
    assert any(t["id"] == tid for t in body)
    for t in body:
        assert "profile_encrypted" not in t
        for field in travelers_mod.PROFILE_FIELDS:
            assert field not in t


def test_viewer_can_read_own_profile(client: TestClient, session: Session, trip_id):
    # A viewer has no create access, so seed their own traveler row directly.
    traveler = Traveler(trip_id=trip_id, user_email=VIEWER, display_name="Viewer Self")
    session.add(traveler)
    session.commit()
    session.refresh(traveler)
    client.put(f"/trips/{trip_id}/travelers/{traveler.id}/profile", json={"full_name": "Viewer Self"}, headers=_headers(OWNER))

    r = client.get(f"/trips/{trip_id}/travelers/{traveler.id}/profile", headers=_headers(VIEWER))
    assert r.status_code == 200
    assert r.json()["full_name"] == "Viewer Self"


def test_viewer_cannot_create_patch_or_put_profile(client: TestClient, session: Session, trip_id):
    assert _create(client, trip_id, VIEWER).status_code == 403

    traveler = Traveler(trip_id=trip_id, user_email=VIEWER, display_name="Viewer Self")
    session.add(traveler)
    session.commit()
    session.refresh(traveler)

    assert client.patch(
        f"/trips/{trip_id}/travelers/{traveler.id}", json={"display_name": "X"}, headers=_headers(VIEWER)
    ).status_code == 403
    assert client.put(
        f"/trips/{trip_id}/travelers/{traveler.id}/profile", json={"full_name": "X"}, headers=_headers(VIEWER)
    ).status_code == 403


# ── non-member / cross-trip ─────────────────────────────────────────────────

def test_non_member_list_404(client: TestClient, trip_id):
    r = client.get(f"/trips/{trip_id}/travelers", headers=_headers(OUTSIDER))
    assert r.status_code == 404


def test_traveler_id_from_another_trip_404_on_every_route(client: TestClient, session: Session, trip_id, real_auth):
    other_trip = Trip(name="Other Trip")
    session.add(other_trip)
    session.commit()
    session.refresh(other_trip)
    session.add(TripMembership(trip_id=other_trip.id, user_email=OWNER, role=TripRole.owner))
    session.commit()

    foreign_id = _create(client, other_trip.id, OWNER, display_name="Elsewhere").json()["id"]

    assert client.patch(f"/trips/{trip_id}/travelers/{foreign_id}", json={"display_name": "X"}, headers=_headers(OWNER)).status_code == 404
    assert client.delete(f"/trips/{trip_id}/travelers/{foreign_id}", headers=_headers(OWNER)).status_code == 404
    assert client.get(f"/trips/{trip_id}/travelers/{foreign_id}/profile", headers=_headers(OWNER)).status_code == 404
    assert client.put(f"/trips/{trip_id}/travelers/{foreign_id}/profile", json={"full_name": "X"}, headers=_headers(OWNER)).status_code == 404
    assert client.delete(f"/trips/{trip_id}/travelers/{foreign_id}/profile", headers=_headers(OWNER)).status_code == 404


# ── profile behavior ─────────────────────────────────────────────────────────

def test_profile_put_sets_has_profile_age_band_and_passport_expiry_on_list(client: TestClient, trip_id, session: Session):
    trip = session.get(Trip, trip_id)
    trip.start_date = datetime(2026, 6, 1)
    session.add(trip)
    session.commit()

    tid = _create(client, trip_id, OWNER, display_name="Kid", user_email=None).json()["id"]
    r = client.put(
        f"/trips/{trip_id}/travelers/{tid}/profile",
        json={"date_of_birth": "2020-01-01", "passport_expiry": "2027-01-01T00:00:00"},
        headers=_headers(OWNER),
    )
    assert r.status_code == 200
    assert r.json()["age_at_trip_start"] == 6   # 2020-01-01 -> 2026-06-01 is 6 years old

    listed = next(t for t in client.get(f"/trips/{trip_id}/travelers", headers=_headers(OWNER)).json() if t["id"] == tid)
    assert listed["has_profile"] is True
    assert listed["age_band"] == "child"
    assert listed["passport_expiry"].startswith("2027-01-01")


def test_profile_age_at_trip_start_falls_back_to_today_when_trip_undated(client: TestClient, trip_id):
    tid = _create(client, trip_id, OWNER, display_name="Adult", user_email=None).json()["id"]
    r = client.put(
        f"/trips/{trip_id}/travelers/{tid}/profile", json={"date_of_birth": "1990-01-01"}, headers=_headers(OWNER)
    )
    assert r.status_code == 200
    expected = travelers_mod.age_at(date(1990, 1, 1), datetime.utcnow().date())
    assert r.json()["age_at_trip_start"] == expected


def test_profile_get_returns_every_d3_key(client: TestClient, trip_id):
    tid = _create(client, trip_id, OWNER, display_name="Full", user_email=None).json()["id"]
    full = {
        "full_name": "Full Name", "date_of_birth": "1990-01-01", "sex": "F",
        "nationality": "AU", "passport_number": "X1234567",
        "passport_issuing_country": "AU", "email": "full@example.com",
        "phone": "+61 400 000 000", "frequent_flyer": [{"airline": "QF", "number": "12345"}],
        "meal_preference": "vegetarian", "seat_preference": "aisle", "notes": "no notes",
    }
    client.put(f"/trips/{trip_id}/travelers/{tid}/profile", json=full, headers=_headers(OWNER))
    got = client.get(f"/trips/{trip_id}/travelers/{tid}/profile", headers=_headers(OWNER)).json()
    for k, v in full.items():
        assert got[k] == v


def test_profile_put_merge_semantics_partial_update_keeps_other_fields(client: TestClient, trip_id):
    tid = _create(client, trip_id, OWNER, display_name="Merge", user_email=None).json()["id"]
    client.put(
        f"/trips/{trip_id}/travelers/{tid}/profile",
        json={"passport_number": "X9999999", "full_name": "Keep Me"}, headers=_headers(OWNER),
    )
    r = client.put(f"/trips/{trip_id}/travelers/{tid}/profile", json={"phone": "555-0000"}, headers=_headers(OWNER))
    assert r.status_code == 200
    assert r.json()["passport_number"] == "X9999999"
    assert r.json()["full_name"] == "Keep Me"
    assert r.json()["phone"] == "555-0000"


def test_profile_delete_clears_derived_fields(client: TestClient, trip_id):
    tid = _create(client, trip_id, OWNER, display_name="Clear", user_email=None).json()["id"]
    client.put(
        f"/trips/{trip_id}/travelers/{tid}/profile",
        json={"date_of_birth": "1990-01-01", "passport_expiry": "2030-01-01T00:00:00"},
        headers=_headers(OWNER),
    )
    assert client.delete(f"/trips/{trip_id}/travelers/{tid}/profile", headers=_headers(OWNER)).status_code == 204

    listed = next(t for t in client.get(f"/trips/{trip_id}/travelers", headers=_headers(OWNER)).json() if t["id"] == tid)
    assert listed["has_profile"] is False
    assert listed["age_band"] is None
    assert listed["passport_expiry"] is None
    assert client.get(f"/trips/{trip_id}/travelers/{tid}/profile", headers=_headers(OWNER)).status_code == 404


def test_key_unset_503_on_profile_put_and_get_list_create_patch_still_work(client: TestClient, trip_id, monkeypatch):
    tid = _create(client, trip_id, OWNER, display_name="Still Works", user_email=None).json()["id"]

    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "")
    assert client.put(f"/trips/{trip_id}/travelers/{tid}/profile", json={"full_name": "X"}, headers=_headers(OWNER)).status_code == 503
    assert client.get(f"/trips/{trip_id}/travelers/{tid}/profile", headers=_headers(OWNER)).status_code == 503

    assert client.get(f"/trips/{trip_id}/travelers", headers=_headers(OWNER)).status_code == 200
    assert _create(client, trip_id, OWNER, display_name="Another", user_email=None).status_code == 201
    assert client.patch(f"/trips/{trip_id}/travelers/{tid}", json={"display_name": "Renamed"}, headers=_headers(OWNER)).status_code == 200


# ── D8 passport_expiry date warning ─────────────────────────────────────────

def test_passport_expiry_warning_when_expiring_3_months_after_trip(client: TestClient, session: Session):
    trip = Trip(name="Warn Trip", end_date=datetime(2026, 12, 31))
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(Traveler(trip_id=trip.id, user_email=None, display_name="Kid", passport_expiry=datetime(2027, 3, 31)))
    session.commit()

    r = client.get(f"/trips/{trip.id}/date-warnings")
    assert r.status_code == 200
    warnings = [w for w in r.json()["warnings"] if w.get("kind") == "passport_expiry"]
    assert len(warnings) == 1
    assert "Kid" in warnings[0]["message"]


def test_no_passport_expiry_warning_when_expiring_9_months_after_trip(client: TestClient, session: Session):
    trip = Trip(name="No Warn Trip", end_date=datetime(2026, 12, 31))
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(Traveler(trip_id=trip.id, user_email=None, display_name="Kid", passport_expiry=datetime(2027, 9, 30)))
    session.commit()

    r = client.get(f"/trips/{trip.id}/date-warnings")
    warnings = [w for w in r.json()["warnings"] if w.get("kind") == "passport_expiry"]
    assert warnings == []


def test_no_passport_expiry_warning_when_no_expiries_stored(client: TestClient, session: Session):
    trip = Trip(name="Bare Trip", end_date=datetime(2026, 12, 31))
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(Traveler(trip_id=trip.id, user_email=None, display_name="No Passport"))
    session.commit()

    r = client.get(f"/trips/{trip.id}/date-warnings")
    warnings = [w for w in r.json()["warnings"] if w.get("kind") == "passport_expiry"]
    assert warnings == []


# ── D7 migration backfill (idempotent) ──────────────────────────────────────

_MIGRATION_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "alembic", "versions", "cb88a616d94d_add_traveler_table.py",
)


def _load_backfill_travelers():
    """Load the migration's backfill_travelers(conn) function directly from
    its file (alembic/versions has no __init__.py, so it isn't an importable
    package) — exercises the exact SQL the real migration runs, against the
    conftest `session` fixture's create_all()-built schema."""
    spec = importlib.util.spec_from_file_location("_traveler_migration_cb88a616d94d", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.backfill_travelers


def test_migration_backfill_inserts_one_traveler_per_membership_and_is_idempotent(session: Session):
    trip = Trip(name="Backfill Trip")
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(TripMembership(trip_id=trip.id, user_email="a@example.com", role=TripRole.owner))
    session.add(TripMembership(trip_id=trip.id, user_email="b@example.com", role=TripRole.viewer))
    session.commit()

    backfill_travelers = _load_backfill_travelers()
    backfill_travelers(session.connection())
    session.commit()

    rows = session.exec(select(Traveler).where(Traveler.trip_id == trip.id)).all()
    assert {r.user_email for r in rows} == {"a@example.com", "b@example.com"}
    assert len(rows) == 2

    # Re-running must not duplicate (NOT EXISTS guard) — a fresh connection()
    # each time since the prior commit() ended the last transaction/connection.
    backfill_travelers(session.connection())
    session.commit()
    rows_again = session.exec(select(Traveler).where(Traveler.trip_id == trip.id)).all()
    assert len(rows_again) == 2


# ── D9 delete_trip cascade ──────────────────────────────────────────────────

def test_delete_trip_removes_travelers(client: TestClient, session: Session):
    trip = client.post("/trips/", json={"name": "Deletable"}).json()
    client.post(f"/trips/{trip['id']}/travelers", json={"display_name": "Someone"})

    assert client.delete(f"/trips/{trip['id']}").status_code == 204
    assert session.exec(select(Traveler).where(Traveler.trip_id == trip["id"])).all() == []


# ── programmatic-API smoke (docs/programmatic-api.md's Travelers section) ──

def test_programmatic_api_smoke_with_pat(client: TestClient):
    token = client.post("/me/api-token", json={"label": "travelers-smoke"}).json()["token"]
    auth_header = {"Authorization": f"Bearer {token}"}

    trip = client.post("/trips/", json={"name": "PAT Trip"}, headers=auth_header).json()
    created = client.post(
        f"/trips/{trip['id']}/travelers", json={"display_name": "Traveler One"}, headers=auth_header
    )
    assert created.status_code == 201
    tid = created.json()["id"]

    listed = client.get(f"/trips/{trip['id']}/travelers", headers=auth_header)
    assert listed.status_code == 200 and len(listed.json()) == 1

    put = client.put(
        f"/trips/{trip['id']}/travelers/{tid}/profile", json={"full_name": "Traveler One"}, headers=auth_header
    )
    assert put.status_code == 200

    got = client.get(f"/trips/{trip['id']}/travelers/{tid}/profile", headers=auth_header)
    assert got.status_code == 200 and got.json()["full_name"] == "Traveler One"

    assert client.delete(f"/trips/{trip['id']}/travelers/{tid}", headers=auth_header).status_code == 204
