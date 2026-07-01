"""Tests for backend/routers/sheets_import.py — the /import/sheets endpoints."""
import csv
import io

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from backend.routers import sheets_import as sheets_import_mod
from backend import importer as importer_mod
from backend.models import Stop, ItineraryItem, ItemKind, TripMembership


def _csv(rows) -> str:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    return buf.getvalue()


def _fake_fetch_sheets(sheets_raw):
    return lambda: sheets_raw


# ── POST /import/sheets ──────────────────────────────────────────────────────

def test_import_from_sheets_creates_trip_and_owner_membership(client: TestClient, session: Session, monkeypatch):
    sheets_raw = {"Paris": _csv([["Paris", "France"]])}
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets(sheets_raw))

    r = client.post("/import/sheets", json={"trip_name": "Europe 2026"})
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Europe 2026"
    assert data["stops_imported"] == 1

    membership = session.exec(
        select(TripMembership).where(TripMembership.trip_id == data["id"])
    ).first()
    assert membership is not None
    assert membership.user_email == "dev@local"
    assert membership.role == "owner"


def test_import_from_sheets_returns_503_when_fetch_fails(client: TestClient, monkeypatch):
    def boom():
        raise RuntimeError("spreadsheet not shared")

    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", boom)
    r = client.post("/import/sheets", json={"trip_name": "Europe 2026"})
    assert r.status_code == 503
    assert "spreadsheet not shared" in r.json()["detail"]


# ── POST /import/sheets/flights/{trip_id} ────────────────────────────────────

def test_import_flights_only_attaches_flights_to_existing_trip(client: TestClient, session: Session, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    client.post(f"/trips/{trip['id']}/stops", json={"location": "Singapore", "status": "planned"})

    sheets_raw = {"Flights": _csv([
        ["From", "To", "Depart Date", "Depart Time"],
        ["Singapore", "Paris", "22/07/2026", "21:35"],
    ])}
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets(sheets_raw))

    r = client.post(f"/import/sheets/flights/{trip['id']}")
    assert r.status_code == 200
    assert r.json()["flights_imported"] == 1


def test_import_flights_only_404s_for_trip_without_stops(client: TestClient, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets({}))

    r = client.post(f"/import/sheets/flights/{trip['id']}")
    assert r.status_code == 404


def test_import_flights_only_503_on_fetch_failure(client: TestClient, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()

    def boom():
        raise RuntimeError("no access")

    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", boom)
    r = client.post(f"/import/sheets/flights/{trip['id']}")
    assert r.status_code == 503


# ── POST /import/sheets/update-stop-dates/{trip_id} ─────────────────────────

def test_update_stop_dates_from_sheets_patches_dates(client: TestClient, session: Session, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Paris", "sort_order": 0, "status": "planned",
    })

    sheets_raw = {"Paris": _csv([
        ["Paris", "France"],
        ["Arrive", "22/07/2026 14:00"],
        ["Depart", "25/07/2026 10:00"],
    ])}
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets(sheets_raw))

    r = client.post(f"/import/sheets/update-stop-dates/{trip['id']}")
    assert r.status_code == 200
    assert r.json()["stops_updated"] == 1


def test_update_stop_dates_from_sheets_404s_without_stops(client: TestClient, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets({}))

    r = client.post(f"/import/sheets/update-stop-dates/{trip['id']}")
    assert r.status_code == 404


# ── GET /import/sheets/flights/{trip_id}/preview ────────────────────────────

def test_preview_flight_assignments_shows_assigned_stop(client: TestClient, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    client.post(f"/trips/{trip['id']}/stops", json={"location": "Singapore", "status": "planned"})

    sheets_raw = {"Flights": _csv([
        ["From", "To", "Depart Date", "Depart Time"],
        ["Singapore", "Paris", "22/07/2026", "21:35"],
    ])}
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets(sheets_raw))

    r = client.get(f"/import/sheets/flights/{trip['id']}/preview")
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["assigned_stop"] == "Singapore"


def test_preview_flight_assignments_404s_without_stops(client: TestClient, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets({}))

    r = client.get(f"/import/sheets/flights/{trip['id']}/preview")
    assert r.status_code == 404


# ── GET /import/sheets/preview ───────────────────────────────────────────────

def test_preview_sheets_caps_rows_at_60(client: TestClient, monkeypatch):
    many_rows = [["row", str(i)] for i in range(100)]
    sheets_raw = {"Big": _csv(many_rows)}
    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", _fake_fetch_sheets(sheets_raw))

    r = client.get("/import/sheets/preview")
    assert r.status_code == 200
    assert len(r.json()["Big"]) == 60


def test_preview_sheets_503_on_fetch_failure(client: TestClient, monkeypatch):
    def boom():
        raise RuntimeError("auth expired")

    monkeypatch.setattr(sheets_import_mod, "fetch_sheets", boom)
    r = client.get("/import/sheets/preview")
    assert r.status_code == 503


# ── POST /import/backfill-scheduled-at/{trip_id} ────────────────────────────

def test_backfill_scheduled_at_parses_notes_into_scheduled_at(client: TestClient, session: Session):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={"location": "Paris", "status": "planned"}).json()
    item = client.post(f"/stops/{stop['id']}/items", json={
        "kind": "activity", "name": "Eiffel Tower", "status": "pending", "notes": "22 Jul 2026",
    }).json()
    assert item["scheduled_at"] is None

    r = client.post(f"/import/backfill-scheduled-at/{trip['id']}")
    assert r.status_code == 200
    assert r.json()["updated"] == 1

    refreshed = client.get(f"/trips/{trip['id']}/timeline").json()
    scheduled = refreshed["stops"][0]["items"][0]["scheduled_at"]
    assert scheduled is not None
    assert scheduled.startswith("2026-07-22")


def test_backfill_scheduled_at_404s_without_stops(client: TestClient):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    r = client.post(f"/import/backfill-scheduled-at/{trip['id']}")
    assert r.status_code == 404


# ── POST /import/enrich-accommodations/{trip_id} ────────────────────────────

def test_enrich_accommodations_endpoint_fills_missing_address(client: TestClient, session: Session, monkeypatch):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={"location": "Paris", "status": "planned"}).json()
    client.post(f"/stops/{stop['id']}/items", json={
        "kind": "accommodation", "name": "Hotel Lutetia", "status": "pending",
    })

    monkeypatch.setattr(importer_mod, "time", type("T", (), {"sleep": staticmethod(lambda *_: None)}))
    monkeypatch.setattr(
        importer_mod, "_lookup_nominatim",
        lambda name, city, country: {"location": "45 Boulevard Raspail", "_lat": "48.8", "_lng": "2.3"},
    )

    r = client.post(f"/import/enrich-accommodations/{trip['id']}")
    assert r.status_code == 200
    assert r.json()["updated"] == 1


def test_enrich_accommodations_endpoint_404s_without_stops(client: TestClient):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    r = client.post(f"/import/enrich-accommodations/{trip['id']}")
    assert r.status_code == 404


# ── POST /import/backfill-accommodations/{trip_id} ──────────────────────────

def test_backfill_accommodations_creates_item_from_stop_fields(client: TestClient, session: Session):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    stop_resp = client.post(f"/trips/{trip['id']}/stops", json={"location": "Paris", "status": "planned"}).json()

    stop = session.get(Stop, stop_resp["id"])
    stop.accommodation = "Hotel Lutetia"
    stop.accommodation_link = "https://hotel-lutetia.com"
    stop.accommodation_notes = "Ask for courtyard room"
    session.add(stop)
    session.commit()

    r = client.post(f"/import/backfill-accommodations/{trip['id']}")
    assert r.status_code == 200
    assert r.json()["created"] == 1

    items = session.exec(
        select(ItineraryItem)
        .where(ItineraryItem.stop_id == stop.id)
        .where(ItineraryItem.kind == ItemKind.accommodation)
    ).all()
    assert len(items) == 1
    assert items[0].name == "Hotel Lutetia"
    assert items[0].details["description"] == "Ask for courtyard room"


def test_backfill_accommodations_skips_stops_with_existing_item(client: TestClient, session: Session):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    stop_resp = client.post(f"/trips/{trip['id']}/stops", json={"location": "Paris", "status": "planned"}).json()

    stop = session.get(Stop, stop_resp["id"])
    stop.accommodation = "Hotel Lutetia"
    session.add(stop)
    session.commit()

    client.post(f"/stops/{stop.id}/items", json={
        "kind": "accommodation", "name": "Hotel Lutetia", "status": "pending",
    })

    r = client.post(f"/import/backfill-accommodations/{trip['id']}")
    assert r.status_code == 200
    assert r.json()["created"] == 0
    assert r.json()["skipped"] == 1


def test_backfill_accommodations_404s_without_stops(client: TestClient):
    trip = client.post("/trips/", json={"name": "Trip"}).json()
    r = client.post(f"/import/backfill-accommodations/{trip['id']}")
    assert r.status_code == 404
