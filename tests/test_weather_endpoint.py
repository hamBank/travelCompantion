"""Tests for the /weather endpoint and its variable-TTL DB cache."""
from datetime import date, datetime, timedelta, timezone

import backend.routers.weather as wr
from backend.models import WeatherCache


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


# ── Variable cache TTL ──────────────────────────────────────────────────────

def test_cache_ttl_today_or_tomorrow_is_immediate():
    today = date(2026, 7, 6)
    assert wr._cache_ttl(today, today, today) == wr.TTL_IMMEDIATE
    assert wr._cache_ttl(today + timedelta(days=1), today + timedelta(days=1), today) == wr.TTL_IMMEDIATE


def test_cache_ttl_two_days_out_is_near():
    today = date(2026, 7, 6)
    assert wr._cache_ttl(today + timedelta(days=2), today + timedelta(days=2), today) == wr.TTL_NEAR


def test_cache_ttl_within_forecast_horizon_is_default():
    today = date(2026, 7, 6)
    assert wr._cache_ttl(today + timedelta(days=3), today + timedelta(days=3), today) == wr.TTL_DEFAULT
    assert wr._cache_ttl(today + timedelta(days=15), today + timedelta(days=15), today) == wr.TTL_DEFAULT


def test_cache_ttl_beyond_horizon_is_far():
    today = date(2026, 7, 6)
    assert wr._cache_ttl(today + timedelta(days=16), today + timedelta(days=16), today) == wr.TTL_FAR


def test_cache_ttl_entirely_past_is_far():
    today = date(2026, 7, 6)
    assert wr._cache_ttl(today - timedelta(days=10), today - timedelta(days=5), today) == wr.TTL_FAR


def test_cache_ttl_uses_the_near_edge_of_a_range():
    # A range that starts tomorrow but runs long is exactly as volatile as one
    # entirely in the next couple of days — the near edge governs.
    today = date(2026, 7, 6)
    assert wr._cache_ttl(today + timedelta(days=1), today + timedelta(days=30), today) == wr.TTL_IMMEDIATE


class _FakeDate(date):
    """A `date` subclass whose `.today()` is fixed, for monkeypatching `wr.date`."""
    _today = date(2026, 7, 6)

    @classmethod
    def today(cls):
        return cls._today


def test_weather_endpoint_refetches_stale_immediate_bucket_entry(client, session, monkeypatch):
    # A 2-hour-old cache entry for *today* is stale under the 1-hour
    # TTL_IMMEDIATE bucket, so it must be refetched rather than served as-is.
    calls = {"n": 0}

    def fake_get_weather(lat, lng, start, end):
        calls["n"] += 1
        return {start: {"tmin": 1, "tmax": 2, "icon": "☀", "desc": "Clear", "source": "forecast"}}

    monkeypatch.setattr(wr, "get_weather", fake_get_weather)
    monkeypatch.setattr(wr, "date", _FakeDate)

    params = {"lat": "1.35", "lng": "103.82", "start": "2026-07-06", "end": "2026-07-06"}
    r1 = client.get("/weather", params=params)
    assert r1.json()["cached"] is False
    assert calls["n"] == 1

    key = wr.cache_key("1.35", "103.82", "2026-07-06", "2026-07-06")
    row = session.get(WeatherCache, key)
    row.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2)
    session.add(row)
    session.commit()

    r2 = client.get("/weather", params=params)
    assert r2.json()["cached"] is False
    assert calls["n"] == 2


def test_weather_endpoint_invalidates_far_bucket_entry_once_date_enters_horizon(client, session, monkeypatch):
    # A date fetched as climatology (16 days out, TTL_FAR) must not coast on
    # that 48-hour window once "today" advances far enough to bring it inside
    # the forecast horizon — the TTL bucket is recomputed fresh from the
    # *current* today on every request, never frozen at fetch time, so a
    # date's effective TTL shrinks the moment its classification changes.
    def fake_get_weather(lat, lng, start, end):
        return {start: {"tmin": 1, "tmax": 2, "icon": "☀", "desc": "Clear", "source": "forecast"}}

    monkeypatch.setattr(wr, "get_weather", fake_get_weather)
    monkeypatch.setattr(wr, "date", _FakeDate)
    _FakeDate._today = date(2026, 7, 6)

    # Fetched while 16 days out — beyond the horizon, climatology, TTL_FAR (48h).
    params = {"lat": "1.35", "lng": "103.82", "start": "2026-07-22", "end": "2026-07-22"}
    r1 = client.get("/weather", params=params)
    assert r1.json()["cached"] is False

    # 7 hours later, "today" has advanced a day (now 15 days out — inside the
    # horizon, TTL_DEFAULT of 6h applies). Under the old fixed 48h TTL this
    # would still read as "fresh" (7h < 48h); it must not.
    key = wr.cache_key("1.35", "103.82", "2026-07-22", "2026-07-22")
    row = session.get(WeatherCache, key)
    row.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=7)
    session.add(row)
    session.commit()
    _FakeDate._today = date(2026, 7, 7)

    r2 = client.get("/weather", params=params)
    assert r2.json()["cached"] is False


def test_weather_endpoint_serves_stale_far_bucket_entry_from_cache(client, session, monkeypatch):
    # The same 2-hour staleness is well within the 48-hour TTL_FAR bucket for
    # a date far beyond the forecast horizon — served from cache, not refetched.
    calls = {"n": 0}

    def fake_get_weather(lat, lng, start, end):
        calls["n"] += 1
        return {start: {"tmin": 1, "tmax": 2, "icon": "☀", "desc": "Clear", "source": "climatology"}}

    monkeypatch.setattr(wr, "get_weather", fake_get_weather)
    monkeypatch.setattr(wr, "date", _FakeDate)
    _FakeDate._today = date(2026, 7, 6)

    params = {"lat": "1.35", "lng": "103.82", "start": "2026-08-01", "end": "2026-08-01"}
    r1 = client.get("/weather", params=params)
    assert r1.json()["cached"] is False
    assert calls["n"] == 1

    key = wr.cache_key("1.35", "103.82", "2026-08-01", "2026-08-01")
    row = session.get(WeatherCache, key)
    row.fetched_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2)
    session.add(row)
    session.commit()

    r2 = client.get("/weather", params=params)
    assert r2.json()["cached"] is True
    assert calls["n"] == 1
