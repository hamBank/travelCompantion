"""Tests for the /weather endpoint and its 6-hour DB cache."""
import backend.routers.weather as wr


def test_weather_endpoint_returns_data_and_caches(client, monkeypatch):
    calls = {"n": 0}

    def fake_get_weather(lat, lng, start, end):
        calls["n"] += 1
        return {"2026-07-22": {"tmin": 21.0, "tmax": 31.0, "icon": "☀", "desc": "Clear", "source": "climatology"}}

    monkeypatch.setattr(wr, "get_weather", fake_get_weather)

    r1 = client.get("/weather", params={"lat": "40.66", "lng": "16.60", "start": "2026-07-22", "end": "2026-07-22"})
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1["cached"] is False
    assert body1["weather"]["2026-07-22"]["tmax"] == 31.0

    # Second identical call is served from cache — get_weather not called again
    r2 = client.get("/weather", params={"lat": "40.66", "lng": "16.60", "start": "2026-07-22", "end": "2026-07-22"})
    assert r2.json()["cached"] is True
    assert calls["n"] == 1


def test_weather_endpoint_geocodes_when_coords_missing(client, monkeypatch):
    geo_calls = {"n": 0}

    def fake_geocode(q):
        geo_calls["n"] += 1
        assert "Duffy" in q
        return (-35.34, 149.03)

    def fake_get_weather(lat, lng, start, end):
        assert (lat, lng) == (-35.34, 149.03)
        return {"2026-08-20": {"tmin": 2, "tmax": 13, "wind": 15, "icon": "☀", "desc": "Clear", "source": "climatology"}}

    monkeypatch.setattr(wr, "geocode", fake_geocode)
    monkeypatch.setattr(wr, "get_weather", fake_get_weather)

    r = client.get("/weather", params={"q": "Duffy, Australia", "start": "2026-08-20", "end": "2026-08-20"})
    assert r.status_code == 200
    assert r.json()["weather"]["2026-08-20"]["tmax"] == 13

    # cached on the q-key — geocode not called again
    r2 = client.get("/weather", params={"q": "Duffy, Australia", "start": "2026-08-20", "end": "2026-08-20"})
    assert r2.json()["cached"] is True
    assert geo_calls["n"] == 1


def test_weather_endpoint_requires_coords_or_q(client):
    r = client.get("/weather", params={"start": "2026-07-22", "end": "2026-07-22"})
    assert r.status_code == 400


def test_weather_endpoint_is_public(client):
    # No Authorization header required (registered under public prefixes)
    r = client.get("/weather", params={"lat": "1.35", "lng": "103.99", "start": "2026-07-22", "end": "2026-07-22"})
    assert r.status_code in (200, 502)  # 200 normally; never 401
