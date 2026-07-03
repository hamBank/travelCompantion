"""Tests for the /items/{id}/flight-check distance check.

The live AeroDataBox lookup already runs for schedule verification; it also
reports greatCircleDistance (real airport-to-airport distance) for free, so
the flight's Distance field can be checked/applied the same way as terminal,
gate, etc. — instead of only ever being hand-typed.
"""
import pytest
from backend.routers import items as items_mod


@pytest.fixture
def flight_item(client):
    trip = client.post("/trips/", json={"name": "Test Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Singapore", "status": "planned"
    }).json()
    return client.post(f"/stops/{stop['id']}/items", json={
        "kind": "flight", "name": "SIN → HEL", "status": "pending",
        "details": {
            "flight_number": "AY 132",
            "depart_time": "2026-07-24T21:35",
        },
    }).json()


class FakeResponse:
    def __init__(self, data, status_code=200):
        self._data = data
        self.status_code = status_code
        self.is_success = 200 <= status_code < 300
    def json(self):
        return self._data


def _live_flight(**overrides):
    base = {
        "departure": {"airport": {"iata": "SIN"}, "scheduledTime": {"local": "2026-07-24 21:35+08:00"}},
        "arrival":   {"airport": {"iata": "HEL"}, "scheduledTime": {"local": "2026-07-25 06:00+03:00"}},
        "airline":   {"name": "Finnair"},
        "status": "scheduled",
    }
    base.update(overrides)
    return base


def _fake_client_returning(flight_data):
    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, headers=None):
            return FakeResponse({"data": [flight_data]})
    return FakeClient


def test_distance_check_prefers_miles(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    live = _live_flight(greatCircleDistance={"meter": 9266400, "km": 9266.4, "mile": 5758.7, "nm": 5003.5})
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 200
    body = r.json()
    dist = next(c for c in body["checks"] if c["key"] == "distance")
    assert dist["live"] == "5,759 mi"
    assert dist["update_value"] == "5,759 mi"
    assert dist["stored"] is None
    assert dist["match"] is None  # nothing stored yet — informational, not a mismatch


def test_distance_check_falls_back_to_km_when_miles_missing(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    live = _live_flight(greatCircleDistance={"km": 9266.4})
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    dist = next(c for c in r.json()["checks"] if c["key"] == "distance")
    assert dist["live"] == "9,266 km"


def test_distance_check_omitted_when_api_has_no_distance_data(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    live = _live_flight()  # no greatCircleDistance key at all
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert all(c["key"] != "distance" for c in r.json()["checks"])


def test_distance_check_flags_mismatch_against_a_differently_typed_stored_value(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    client.patch(f"/items/{flight_item['id']}", json={"details": {**flight_item["details"], "distance": "5000 mi"}})
    live = _live_flight(greatCircleDistance={"mile": 5758.7})
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    dist = next(c for c in r.json()["checks"] if c["key"] == "distance")
    assert dist["match"] is False
    assert dist["update_value"] == "5,759 mi"
