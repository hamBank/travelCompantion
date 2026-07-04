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
    def __init__(self, data=None, status_code=200, text=None, reason_phrase="Error"):
        self._data = data
        self.status_code = status_code
        self.is_success = 200 <= status_code < 300
        self.text = text if text is not None else ""
        self.reason_phrase = reason_phrase
    def json(self):
        if self._data is None:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._data


def _live_flight(**overrides):
    base = {
        "departure": {"airport": {"iata": "SIN"}, "scheduledTime": {"local": "2026-07-24 21:35+08:00", "utc": "2026-07-24 13:35"}},
        "arrival":   {"airport": {"iata": "HEL"}, "scheduledTime": {"local": "2026-07-25 06:00+03:00", "utc": "2026-07-25 03:00"}},
        "airline":   {"name": "Finnair"},
        "status": "Expected",
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


# ── departure/arrival delay ───────────────────────────────────────────────────

def test_delay_reports_late_departure_in_minutes(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    live = _live_flight(departure={
        "airport": {"iata": "SIN"},
        "scheduledTime": {"utc": "2026-07-24 13:35"},
        "revisedTime": {"utc": "2026-07-24 14:20"},
    })
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["departure_delay_min"] == 45
    assert body["departure_delay"] == "45m late"


def test_delay_reports_early_arrival_as_negative_minutes(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    live = _live_flight(arrival={
        "airport": {"iata": "HEL"},
        "scheduledTime": {"utc": "2026-07-25 03:00"},
        "revisedTime": {"utc": "2026-07-25 02:15"},
    })
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["arrival_delay_min"] == -45
    assert body["arrival_delay"] == "45m early"


def test_delay_formats_hours_and_minutes(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    live = _live_flight(departure={
        "airport": {"iata": "SIN"},
        "scheduledTime": {"utc": "2026-07-24 13:35"},
        "revisedTime": {"utc": "2026-07-24 15:05"},
    })
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["departure_delay_min"] == 90
    assert body["departure_delay"] == "1h 30m late"


def test_delay_reports_on_time_when_revised_matches_scheduled(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    live = _live_flight(departure={
        "airport": {"iata": "SIN"},
        "scheduledTime": {"utc": "2026-07-24 13:35"},
        "revisedTime": {"utc": "2026-07-24 13:35"},
    })
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["departure_delay_min"] == 0
    assert body["departure_delay"] == "On time"


def test_delay_is_none_when_no_revision_has_been_issued(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    # _live_flight's default departure/arrival have scheduledTime but no revisedTime
    live = _live_flight()
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["departure_delay_min"] is None
    assert body["departure_delay"] is None
    assert body["arrival_delay_min"] is None
    assert body["arrival_delay"] is None


# ── error handling: non-JSON / non-2xx responses shouldn't say "unreachable" ──

def _fake_client(response):
    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, headers=None):
            return response
    return FakeClient


def test_rate_limited_html_error_page_is_not_reported_as_unreachable(client, session, flight_item, monkeypatch):
    # Regression: RapidAPI's 429/403 error pages are plain text/HTML, not
    # JSON — the old code called r.json() unconditionally and let the
    # resulting JSONDecodeError get caught and mislabeled as "Flight API
    # unreachable", hiding the real (rate limit / auth) cause.
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    resp = FakeResponse(status_code=429, text="Too Many Requests", reason_phrase="Too Many Requests")
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client(resp))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert "unreachable" not in r.json()["detail"].lower()
    assert "Too Many Requests" in r.json()["detail"]


def test_non_2xx_json_error_body_still_extracts_message(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    resp = FakeResponse({"message": "Invalid API key"}, status_code=403)
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client(resp))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert r.json()["detail"] == "Invalid API key"


def test_2xx_response_with_unparseable_body_gives_a_clear_message(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")
    resp = FakeResponse(status_code=200)  # data=None → .json() raises, like the old bug's real case
    monkeypatch.setattr(items_mod.httpx, "Client", _fake_client(resp))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert "unreachable" not in r.json()["detail"].lower()
    assert "non-JSON" in r.json()["detail"]


def test_genuine_connection_failure_is_still_reported_as_unreachable(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_AERODATABOX_KEY", "fake-key")

    class FailingClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, headers=None):
            raise ConnectionError("Connection refused")
    monkeypatch.setattr(items_mod.httpx, "Client", FailingClient)

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert "unreachable" in r.json()["detail"].lower()
