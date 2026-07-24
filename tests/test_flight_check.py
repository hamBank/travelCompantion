"""Tests for the /items/{id}/flight-check distance check.

The live AeroDataBox lookup already runs for schedule verification; it also
reports greatCircleDistance (real airport-to-airport distance) for free, so
the flight's Distance field can be checked/applied the same way as terminal,
gate, etc. — instead of only ever being hand-typed.
"""
import pytest
from backend import flight_live


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
        def get(self, url, params=None, headers=None):
            return FakeResponse({"data": [flight_data]})
    return FakeClient


def test_distance_check_prefers_miles(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(greatCircleDistance={"meter": 9266400, "km": 9266.4, "mile": 5758.7, "nm": 5003.5})
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 200
    body = r.json()
    dist = next(c for c in body["checks"] if c["key"] == "distance")
    assert dist["live"] == "5,759 mi"
    assert dist["update_value"] == "5,759 mi"
    assert dist["stored"] is None
    assert dist["match"] is None  # nothing stored yet — informational, not a mismatch


def test_distance_check_falls_back_to_km_when_miles_missing(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(greatCircleDistance={"km": 9266.4})
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    dist = next(c for c in r.json()["checks"] if c["key"] == "distance")
    assert dist["live"] == "9,266 km"


def test_distance_check_omitted_when_api_has_no_distance_data(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight()  # no greatCircleDistance key at all
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert all(c["key"] != "distance" for c in r.json()["checks"])


def test_distance_check_flags_mismatch_against_a_differently_typed_stored_value(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    client.patch(f"/items/{flight_item['id']}", json={"details": {**flight_item["details"], "distance": "5000 mi"}})
    live = _live_flight(greatCircleDistance={"mile": 5758.7})
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    dist = next(c for c in r.json()["checks"] if c["key"] == "distance")
    assert dist["match"] is False
    assert dist["update_value"] == "5,759 mi"


# ── departure/arrival delay ───────────────────────────────────────────────────

def test_delay_reports_late_departure_in_minutes(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(departure={
        "airport": {"iata": "SIN"},
        "scheduledTime": {"utc": "2026-07-24 13:35"},
        "revisedTime": {"utc": "2026-07-24 14:20"},
    })
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["departure_delay_min"] == 45
    assert body["departure_delay"] == "45m late"


def test_delay_reports_early_arrival_as_negative_minutes(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(arrival={
        "airport": {"iata": "HEL"},
        "scheduledTime": {"utc": "2026-07-25 03:00"},
        "revisedTime": {"utc": "2026-07-25 02:15"},
    })
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["arrival_delay_min"] == -45
    assert body["arrival_delay"] == "45m early"


def test_delay_formats_hours_and_minutes(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(departure={
        "airport": {"iata": "SIN"},
        "scheduledTime": {"utc": "2026-07-24 13:35"},
        "revisedTime": {"utc": "2026-07-24 15:05"},
    })
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["departure_delay_min"] == 90
    assert body["departure_delay"] == "1h 30m late"


def test_delay_reports_on_time_when_revised_matches_scheduled(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(departure={
        "airport": {"iata": "SIN"},
        "scheduledTime": {"utc": "2026-07-24 13:35"},
        "revisedTime": {"utc": "2026-07-24 13:35"},
    })
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["departure_delay_min"] == 0
    assert body["departure_delay"] == "On time"


def test_delay_is_none_when_no_revision_has_been_issued(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    # _live_flight's default departure/arrival have scheduledTime but no revisedTime
    live = _live_flight()
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

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
        def get(self, url, params=None, headers=None):
            return response
    return FakeClient


def test_rate_limited_html_error_page_is_not_reported_as_unreachable(client, session, flight_item, monkeypatch):
    # Regression: RapidAPI's 429/403 error pages are plain text/HTML, not
    # JSON — the old code called r.json() unconditionally and let the
    # resulting JSONDecodeError get caught and mislabeled as "Flight API
    # unreachable", hiding the real (rate limit / auth) cause.
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    resp = FakeResponse(status_code=429, text="Too Many Requests", reason_phrase="Too Many Requests")
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client(resp))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert "unreachable" not in r.json()["detail"].lower()
    assert "Too Many Requests" in r.json()["detail"]


def test_non_2xx_json_error_body_still_extracts_message(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    resp = FakeResponse({"message": "Invalid API key"}, status_code=403)
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client(resp))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert r.json()["detail"] == "Invalid API key"


def test_2xx_response_with_unparseable_body_gives_a_clear_message(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    resp = FakeResponse(status_code=200)  # data=None → .json() raises, like the old bug's real case
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client(resp))

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert "unreachable" not in r.json()["detail"].lower()
    assert "non-JSON" in r.json()["detail"]


def test_genuine_connection_failure_is_still_reported_as_unreachable(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")

    class FailingClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, params=None, headers=None):
            raise ConnectionError("Connection refused")
    monkeypatch.setattr(flight_live.httpx, "Client", FailingClient)

    r = client.get(f"/items/{flight_item['id']}/flight-check")
    assert r.status_code == 502
    assert "unreachable" in r.json()["detail"].lower()


# ── live aircraft position ("Where is my flight") ─────────────────────────────

def test_aircraft_position_populated_when_location_present(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(location={
        "lat": 1.35, "lon": 103.99,
        "reportedAtUtc": "2026-07-24 14:05",
        "groundSpeed": {"kt": 480, "kmPerHour": 889},
        "altitude": {"feet": 36000, "meter": 10973},
    })
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    pos = body["aircraft_position"]
    assert pos["lat"] == 1.35
    assert pos["lng"] == 103.99  # AeroDataBox's `lon` renamed to `lng`
    assert pos["reported_at_utc"] == "2026-07-24 14:05"
    assert pos["ground_speed_kt"] == 480
    assert pos["altitude_ft"] == 36000


def test_aircraft_position_null_when_no_location_key(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight()  # no location key at all — pre-departure/landed/unavailable
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["aircraft_position"] is None


def test_aircraft_position_nulls_optional_fields_when_partial(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    live = _live_flight(location={"lat": 1.35, "lon": 103.99})  # no speed/altitude/time
    monkeypatch.setattr(flight_live.httpx, "Client", _fake_client_returning(live))

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    pos = body["aircraft_position"]
    assert pos["lat"] == 1.35 and pos["lng"] == 103.99
    assert pos["reported_at_utc"] is None
    assert pos["ground_speed_kt"] is None
    assert pos["altitude_ft"] is None


def test_fetch_flight_requests_with_location(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    captured = {}

    class CapturingClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, params=None, headers=None):
            captured["params"] = params
            return FakeResponse({"data": [_live_flight()]})
    monkeypatch.setattr(flight_live.httpx, "Client", CapturingClient)

    client.get(f"/items/{flight_item['id']}/flight-check")
    assert captured["params"] == {"withLocation": "true"}


# ── Multi-result disambiguation ──────────────────────────────────────────────
# Regression: AeroDataBox's number+date lookup isn't guaranteed to return
# exactly one flight — a reused flight number, or their date bucketing
# landing on a different UTC/local day, can surface more than one candidate.
# Blindly taking flights[0] risks handing back an already-departed instance
# of the same number — confirmed live for AY132, reported as showing
# "EnRoute" 12 hours before its actual departure.

def test_picks_the_candidate_closest_to_the_stored_depart_time_not_flights_zero(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    # flight_item's stored depart_time is "2026-07-24T21:35". flights[0] here
    # is a stale, already-airborne instance from the day before; the second
    # entry is the one that actually matches what's stored.
    wrong_day = _live_flight(status="EnRoute", **{
        "departure": {"airport": {"iata": "SIN"}, "scheduledTime": {"local": "2026-07-23 21:35+08:00", "utc": "2026-07-23 13:35"}},
    })
    correct_day = _live_flight(status="Expected")  # 2026-07-24 21:35+08:00, matches flight_item exactly

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, params=None, headers=None):
            return FakeResponse({"data": [wrong_day, correct_day]})
    monkeypatch.setattr(flight_live.httpx, "Client", FakeClient)

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["flight_status"] == "Expected"


def test_picks_the_closest_candidate_even_when_neither_is_a_close_match(client, session, flight_item, monkeypatch):
    monkeypatch.setattr(flight_live, "AERODATABOX_KEY", "fake-key")
    # Neither candidate is genuinely close to the stored depart_time
    # (2026-07-24) — there's no arbitrary "good enough" cutoff, it always
    # picks whichever is nearest, so Feb 2 (closer to Jul 24 than Jan 1) wins.
    farther = _live_flight(status="Landed", **{
        "departure": {"airport": {"iata": "SIN"}, "scheduledTime": {"local": "2026-01-01 21:35+08:00", "utc": "2026-01-01 13:35"}},
    })
    closer = _live_flight(status="Canceled", **{
        "departure": {"airport": {"iata": "SIN"}, "scheduledTime": {"local": "2026-02-02 21:35+08:00", "utc": "2026-02-02 13:35"}},
    })

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, params=None, headers=None):
            return FakeResponse({"data": [farther, closer]})
    monkeypatch.setattr(flight_live.httpx, "Client", FakeClient)

    body = client.get(f"/items/{flight_item['id']}/flight-check").json()
    assert body["flight_status"] == "Canceled"


def test_best_match_unit_prefers_closest_scheduled_departure():
    stored = "2026-07-24T21:35"
    candidates = [
        {"departure": {"scheduledTime": {"local": "2026-07-23 21:35+08:00"}}},
        {"departure": {"scheduledTime": {"local": "2026-07-24 21:40+08:00"}}},
        {"departure": {"scheduledTime": {"local": "2026-07-25 21:35+08:00"}}},
    ]
    assert flight_live._best_match(candidates, stored) is candidates[1]


def test_best_match_unit_returns_none_for_empty_list():
    assert flight_live._best_match([], "2026-07-24T21:35") is None


def test_best_match_unit_returns_first_when_only_one_candidate():
    only = [{"departure": {"scheduledTime": {"local": "2026-01-01 00:00+00:00"}}}]
    assert flight_live._best_match(only, "2026-07-24T21:35") is only[0]


def test_best_match_unit_returns_first_when_stored_depart_is_missing_or_unparseable():
    candidates = [{"a": 1}, {"b": 2}]
    assert flight_live._best_match(candidates, None) is candidates[0]
    assert flight_live._best_match(candidates, "not-a-date") is candidates[0]
