"""Creator auto-added as a traveler, GET /me/travelers, and documents assigned
to a traveler other than the signed-in user (UserDocument.traveler_name)."""
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from backend import document_crypto

from backend.models import PushSubscription, Traveler, Trip, TripMembership, TripRole, UserDocument
from backend.notifications import send_document_expiry_reminders

NOW = datetime(2026, 1, 1)


@pytest.fixture(autouse=True)
def _vault_key(monkeypatch):
    monkeypatch.setattr(document_crypto, "DOCUMENT_ENCRYPTION_KEY", "zzc1BvE6r16LzTX2WeXAyIfYP4bpFqQPzTU-JBBjfk8=")


def test_creating_a_trip_adds_the_creator_as_a_traveler(client: TestClient):
    trip = client.post("/trips/", json={"name": "Japan"}).json()
    travelers = client.get(f"/trips/{trip['id']}/travelers").json()
    assert len(travelers) == 1
    assert travelers[0]["user_email"] == "dev@localhost"
    assert travelers[0]["display_name"] == "Dev"


def test_creator_can_remove_themselves_when_only_planning(client: TestClient):
    trip = client.post("/trips/", json={"name": "Planning only"}).json()
    tid = client.get(f"/trips/{trip['id']}/travelers").json()[0]["id"]
    assert client.delete(f"/trips/{trip['id']}/travelers/{tid}").status_code == 204
    assert client.get(f"/trips/{trip['id']}/travelers").json() == []


def test_known_travelers_lists_each_person_once_across_trips(client: TestClient):
    a = client.post("/trips/", json={"name": "A"}).json()
    b = client.post("/trips/", json={"name": "B"}).json()
    for trip in (a, b):
        client.post(f"/trips/{trip['id']}/travelers", json={"display_name": "Mia"})
    known = client.get("/me/travelers").json()
    names = sorted(k["display_name"] for k in known)
    assert names == ["Dev", "Mia"]
    assert [k for k in known if k["is_me"]][0]["display_name"] == "Dev"


def test_document_can_be_assigned_to_a_traveler_and_back(client: TestClient):
    created = client.post("/me/documents", json={"doc_type": "passport", "traveler_name": "Mia"}).json()
    assert created["traveler_name"] == "Mia"
    patched = client.patch(f"/me/documents/{created['id']}", json={"traveler_name": None}).json()
    assert patched["traveler_name"] is None


def _setup(session, traveler_name):
    trip = Trip(name="Italy", end_date=NOW + timedelta(days=30))
    session.add(trip)
    session.commit()
    session.refresh(trip)
    session.add(TripMembership(trip_id=trip.id, user_email="me@x.com", role=TripRole.owner))
    session.add(PushSubscription(user_email="me@x.com", endpoint="https://push/me", p256dh="p", auth="a"))
    session.add(Traveler(trip_id=trip.id, display_name="Me", user_email="me@x.com"))
    session.add(Traveler(trip_id=trip.id, display_name="Mia"))
    session.add(UserDocument(user_email="me@x.com", doc_type="passport", label="Passport",
                             expiry_date=NOW + timedelta(days=60), traveler_name=traveler_name))
    session.commit()
    return trip


def test_reminder_for_a_childs_passport_names_them_and_goes_to_the_owner(session):
    _setup(session, "Mia")
    sent = []
    n = send_document_expiry_reminders(session, now=NOW, sender=lambda info, payload, urgent=False: sent.append((info, payload)))
    assert n == 1
    assert "Mia's Passport" in sent[0][1]["body"]
    assert sent[0][0]["endpoint"] == "https://push/me"


def test_reminder_skipped_when_the_assigned_person_is_not_on_the_trip(session):
    _setup(session, "Somebody Else")
    sent = []
    assert send_document_expiry_reminders(session, now=NOW, sender=lambda *a, **k: sent.append(a)) == 0
