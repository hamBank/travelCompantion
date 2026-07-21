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
    # Pin "today" well before the requested date so it's unambiguously beyond
    # the forecast horizon (a climatology source there is normal, not
    # degraded) — this test is about cache mechanics, not the degraded-payload
    # guard, and shouldn't depend on the real wall-clock date it happens to run on.
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 6, 1))

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


def test_weather_endpoint_refetches_stale_immediate_bucket_entry(client, session, monkeypatch):
    # A 2-hour-old cache entry for *today* is stale under the 1-hour
    # TTL_IMMEDIATE bucket, so it must be refetched rather than served as-is.
    calls = {"n": 0}

    def fake_get_weather(lat, lng, start, end):
        calls["n"] += 1
        return {start: {"tmin": 1, "tmax": 2, "icon": "☀", "desc": "Clear", "source": "forecast"}}

    monkeypatch.setattr(wr, "get_weather", fake_get_weather)
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 7, 6))

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
    fake_today = {"value": date(2026, 7, 6)}
    monkeypatch.setattr(wr, "utc_today", lambda: fake_today["value"])

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
    fake_today["value"] = date(2026, 7, 7)

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
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 7, 6))

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


# ── Degraded-payload cache guard ─────────────────────────────────────────────

def test_weather_endpoint_degraded_payload_not_cached(client, session, monkeypatch):
    # An in-horizon date that comes back as climatology (not "forecast") means
    # the live-forecast fetch failed upstream — the data is still returned to
    # the caller, but must NOT be written to the cache, so the next request
    # retries fresh instead of serving this poisoned data for up to 48h.
    calls = {"n": 0}

    def degraded_get_weather(lat, lng, start, end):
        calls["n"] += 1
        return {start: {"tmin": 1, "tmax": 2, "icon": "☀", "desc": "Clear", "source": "climatology"}}

    monkeypatch.setattr(wr, "get_weather", degraded_get_weather)
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 7, 6))

    params = {"lat": "1.35", "lng": "103.82", "start": "2026-07-06", "end": "2026-07-06"}
    r1 = client.get("/weather", params=params)
    assert r1.json()["cached"] is False
    assert r1.json()["weather"]["2026-07-06"]["source"] == "climatology"  # still returned to caller

    key = wr.cache_key("1.35", "103.82", "2026-07-06", "2026-07-06")
    assert session.get(WeatherCache, key) is None  # nothing written

    # Second request must hit get_weather again — nothing was cached.
    r2 = client.get("/weather", params=params)
    assert r2.json()["cached"] is False
    assert calls["n"] == 2


def test_weather_endpoint_degraded_refetch_does_not_overwrite_existing_row(client, session, monkeypatch):
    # A pre-existing (expired) cache row holding good data must survive a
    # degraded refetch untouched — overwriting it would destroy possibly-good
    # old data with definitely-bad new data.
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 7, 6))
    key = wr.cache_key("1.35", "103.82", "2026-07-06", "2026-07-06")
    good_payload = {"2026-07-06": {"tmin": 10, "tmax": 20, "icon": "☀", "desc": "Clear", "source": "forecast"}}
    old_fetched_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2)
    session.add(WeatherCache(cache_key=key, payload=good_payload, fetched_at=old_fetched_at))
    session.commit()

    def degraded_get_weather(lat, lng, start, end):
        return {start: {"tmin": 1, "tmax": 2, "icon": "☀", "desc": "Clear", "source": "climatology"}}

    monkeypatch.setattr(wr, "get_weather", degraded_get_weather)

    params = {"lat": "1.35", "lng": "103.82", "start": "2026-07-06", "end": "2026-07-06"}
    r = client.get("/weather", params=params)
    assert r.json()["cached"] is False
    assert r.json()["weather"]["2026-07-06"]["source"] == "climatology"  # served to caller anyway

    row = session.get(WeatherCache, key)
    assert row.payload == good_payload      # untouched — not overwritten with bad data
    assert row.fetched_at == old_fetched_at


def test_weather_endpoint_normal_mixed_payload_is_cached(client, session, monkeypatch):
    # In-horizon days as "forecast" + far-out days as "climatology" is the
    # normal, healthy shape of a payload and must be cached as usual — this is
    # NOT a degraded payload. today=2026-07-06 → horizon runs through 2026-07-21.
    today = date(2026, 7, 6)
    horizon_end = today + timedelta(days=15)
    monkeypatch.setattr(wr, "utc_today", lambda: today)

    def mixed_get_weather(lat, lng, start, end):
        start_d, end_d = date.fromisoformat(start), date.fromisoformat(end)
        out, d = {}, start_d
        while d <= end_d:
            source = "forecast" if d <= horizon_end else "climatology"
            out[d.isoformat()] = {"tmin": 5, "tmax": 15, "icon": "☀", "desc": "Clear", "source": source}
            d += timedelta(days=1)
        return out

    monkeypatch.setattr(wr, "get_weather", mixed_get_weather)

    params = {"lat": "1.35", "lng": "103.82", "start": "2026-07-06", "end": "2026-08-01"}
    r1 = client.get("/weather", params=params)
    assert r1.json()["cached"] is False

    key = wr.cache_key("1.35", "103.82", "2026-07-06", "2026-08-01")
    row = session.get(WeatherCache, key)
    assert row is not None
    assert row.payload["2026-08-01"]["source"] == "climatology"

    r2 = client.get("/weather", params=params)
    assert r2.json()["cached"] is True


# ── /weather/hourly ──────────────────────────────────────────────────────────

def _hourly_data(day="2026-07-01"):
    return {
        "date": day,
        "hourly": [{"time": "00:00", "temp": 20.0, "feels_like": 19.0, "precip_prob": 10,
                    "humidity": 55, "wind": 12.0, "uv": 0.0, "icon": "☀", "desc": "Clear"}],
        "sunrise": "06:12", "sunset": "20:45", "uv_max": 6.2, "precip_sum": 0.4, "precip_prob_max": 30,
    }


def test_weather_hourly_returns_data_and_caches(client, monkeypatch):
    calls = {"n": 0}

    def fake_get_hourly(lat, lng, day, today=None):
        calls["n"] += 1
        return _hourly_data()

    monkeypatch.setattr(wr, "get_hourly_forecast", fake_get_hourly)
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 6, 25))

    r1 = client.get("/weather/hourly", params={"lat": "48.85", "lng": "2.35", "day": "2026-07-01"})
    assert r1.status_code == 200
    body = r1.json()
    assert body["cached"] is False
    assert body["hourly"]["date"] == "2026-07-01"

    r2 = client.get("/weather/hourly", params={"lat": "48.85", "lng": "2.35", "day": "2026-07-01"})
    assert r2.json()["cached"] is True
    assert calls["n"] == 1


def test_weather_hourly_geocodes_when_coords_missing(client, monkeypatch):
    def fake_geocode(q):
        assert "Duffy" in q
        return (-35.34, 149.03)

    def fake_get_hourly(lat, lng, day, today=None):
        assert (lat, lng) == (-35.34, 149.03)
        return _hourly_data("2026-07-05")

    monkeypatch.setattr(wr, "geocode", fake_geocode)
    monkeypatch.setattr(wr, "get_hourly_forecast", fake_get_hourly)
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 6, 25))

    r = client.get("/weather/hourly", params={"q": "Duffy, Australia", "day": "2026-07-05"})
    assert r.status_code == 200
    assert r.json()["hourly"]["date"] == "2026-07-05"


def test_weather_hourly_404s_beyond_the_forecast_horizon(client, monkeypatch):
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 6, 25))
    r = client.get("/weather/hourly", params={"lat": "48.85", "lng": "2.35", "day": "2026-08-01"})
    assert r.status_code == 404


def test_weather_hourly_requires_coords_or_q(client, monkeypatch):
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 6, 25))
    r = client.get("/weather/hourly", params={"day": "2026-07-01"})
    assert r.status_code == 400


def test_weather_hourly_503s_on_fetch_failure_with_nothing_cached(client, monkeypatch):
    monkeypatch.setattr(wr, "get_hourly_forecast", lambda lat, lng, day, today=None: None)
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 6, 25))
    r = client.get("/weather/hourly", params={"lat": "48.85", "lng": "2.35", "day": "2026-07-01"})
    assert r.status_code == 503


def test_weather_hourly_serves_stale_cache_on_fetch_failure(client, session, monkeypatch):
    monkeypatch.setattr(wr, "utc_today", lambda: date(2026, 6, 25))
    # Prime the cache with a real (now-expired) entry.
    monkeypatch.setattr(wr, "get_hourly_forecast", lambda lat, lng, day, today=None: _hourly_data())
    client.get("/weather/hourly", params={"lat": "48.85", "lng": "2.35", "day": "2026-07-01"})
    key = f"{wr.HOURLY_CACHE_VERSION},48.85,2.35,2026-07-01"
    row = session.get(WeatherCache, key)
    row.fetched_at = row.fetched_at - timedelta(hours=999)
    session.add(row); session.commit()

    # Now the upstream fetch fails — must fall back to the stale cached row
    # rather than 503ing and losing previously-good data.
    monkeypatch.setattr(wr, "get_hourly_forecast", lambda lat, lng, day, today=None: None)
    r = client.get("/weather/hourly", params={"lat": "48.85", "lng": "2.35", "day": "2026-07-01"})
    assert r.status_code == 200
    assert r.json()["stale"] is True
