"""Unit tests for backend/permissions.py — per-trip role enforcement."""
import pytest
from fastapi import HTTPException
from sqlmodel import Session

from backend import permissions
from backend.models import Trip, Stop, ItineraryItem, TripMembership, TripRole


def _make_trip(session: Session, name="Trip") -> Trip:
    trip = Trip(name=name)
    session.add(trip)
    session.commit()
    session.refresh(trip)
    return trip


def _make_stop(session: Session, trip_id: int, location="City") -> Stop:
    stop = Stop(trip_id=trip_id, location=location)
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop


def _make_item(session: Session, stop_id: int, name="Item") -> ItineraryItem:
    item = ItineraryItem(stop_id=stop_id, name=name)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


# ── user_role_for_trip ───────────────────────────────────────────────────────

def test_user_role_for_trip_returns_owner_when_auth_disabled(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", False)
    trip = _make_trip(session)
    role = permissions.user_role_for_trip(session, "nobody@example.com", trip.id)
    assert role == TripRole.owner


def test_user_role_for_trip_returns_none_without_membership(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    role = permissions.user_role_for_trip(session, "stranger@example.com", trip.id)
    assert role is None


def test_user_role_for_trip_returns_membership_role(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    session.add(TripMembership(trip_id=trip.id, user_email="editor@example.com", role=TripRole.editor))
    session.commit()

    role = permissions.user_role_for_trip(session, "editor@example.com", trip.id)
    assert role == TripRole.editor


def test_user_role_for_trip_matches_case_insensitively(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    session.add(TripMembership(trip_id=trip.id, user_email="viewer@example.com", role=TripRole.viewer))
    session.commit()

    role = permissions.user_role_for_trip(session, "Viewer@Example.com", trip.id)
    assert role == TripRole.viewer


# ── require_trip_role ────────────────────────────────────────────────────────

def test_require_trip_role_404s_when_trip_missing(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    with pytest.raises(HTTPException) as exc:
        permissions.require_trip_role(session, {"email": "a@example.com"}, 99999, TripRole.viewer)
    assert exc.value.status_code == 404


def test_require_trip_role_404s_without_leaking_existence_when_no_access(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    with pytest.raises(HTTPException) as exc:
        permissions.require_trip_role(session, {"email": "stranger@example.com"}, trip.id, TripRole.viewer)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Trip not found"


def test_require_trip_role_403s_when_role_too_low(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    session.add(TripMembership(trip_id=trip.id, user_email="viewer@example.com", role=TripRole.viewer))
    session.commit()

    with pytest.raises(HTTPException) as exc:
        permissions.require_trip_role(session, {"email": "viewer@example.com"}, trip.id, TripRole.editor)
    assert exc.value.status_code == 403


def test_require_trip_role_allows_exact_minimum_role(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    session.add(TripMembership(trip_id=trip.id, user_email="editor@example.com", role=TripRole.editor))
    session.commit()

    role = permissions.require_trip_role(session, {"email": "editor@example.com"}, trip.id, TripRole.editor)
    assert role == TripRole.editor


def test_require_trip_role_allows_higher_than_minimum_role(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    session.add(TripMembership(trip_id=trip.id, user_email="owner@example.com", role=TripRole.owner))
    session.commit()

    role = permissions.require_trip_role(session, {"email": "owner@example.com"}, trip.id, TripRole.viewer)
    assert role == TripRole.owner


def test_require_trip_role_treats_everyone_as_owner_when_auth_disabled(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", False)
    trip = _make_trip(session)
    # No TripMembership row at all — dev mode should still grant owner access.
    role = permissions.require_trip_role(session, {"email": "anyone@example.com"}, trip.id, TripRole.owner)
    assert role == TripRole.owner


# ── trip_id_for_stop / trip_id_for_item ─────────────────────────────────────

def test_trip_id_for_stop_returns_trip_id(session: Session):
    trip = _make_trip(session)
    stop = _make_stop(session, trip.id)
    assert permissions.trip_id_for_stop(session, stop.id) == trip.id


def test_trip_id_for_stop_404s_when_stop_missing(session: Session):
    with pytest.raises(HTTPException) as exc:
        permissions.trip_id_for_stop(session, 99999)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Stop not found"


def test_trip_id_for_item_returns_trip_id(session: Session):
    trip = _make_trip(session)
    stop = _make_stop(session, trip.id)
    item = _make_item(session, stop.id)
    assert permissions.trip_id_for_item(session, item.id) == trip.id


def test_trip_id_for_item_404s_when_item_missing(session: Session):
    with pytest.raises(HTTPException) as exc:
        permissions.trip_id_for_item(session, 99999)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Item not found"


# ── require_stop_role / require_item_role ───────────────────────────────────

def test_require_stop_role_enforces_trip_role(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    stop = _make_stop(session, trip.id)
    session.add(TripMembership(trip_id=trip.id, user_email="viewer@example.com", role=TripRole.viewer))
    session.commit()

    with pytest.raises(HTTPException) as exc:
        permissions.require_stop_role(session, {"email": "viewer@example.com"}, stop.id, TripRole.editor)
    assert exc.value.status_code == 403


def test_require_stop_role_404s_when_stop_missing(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    with pytest.raises(HTTPException) as exc:
        permissions.require_stop_role(session, {"email": "a@example.com"}, 99999, TripRole.viewer)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Stop not found"


def test_require_item_role_enforces_trip_role(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    trip = _make_trip(session)
    stop = _make_stop(session, trip.id)
    item = _make_item(session, stop.id)
    session.add(TripMembership(trip_id=trip.id, user_email="editor@example.com", role=TripRole.editor))
    session.commit()

    role = permissions.require_item_role(session, {"email": "editor@example.com"}, item.id, TripRole.viewer)
    assert role == TripRole.editor


def test_require_item_role_404s_when_item_missing(session: Session, monkeypatch):
    monkeypatch.setattr(permissions, "AUTH_ENABLED", True)
    with pytest.raises(HTTPException) as exc:
        permissions.require_item_role(session, {"email": "a@example.com"}, 99999, TripRole.viewer)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Item not found"
