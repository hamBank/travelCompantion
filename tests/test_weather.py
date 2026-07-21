"""Tests for backend/weather.py — forecast + climatology with mocked network."""
from datetime import date, datetime, timedelta, timezone

from backend import weather


def _daily(times, tmax, tmin, codes, winds=None):
    d = {"time": times, "temperature_2m_max": tmax,
         "temperature_2m_min": tmin, "weathercode": codes}
    if winds is not None:
        d["windspeed_10m_max"] = winds
    return {"daily": d}


def test_parse_daily_skips_null_rows_and_keeps_wind():
    payload = _daily(
        ["2026-07-22", "2026-07-23"], [30, None], [20, 18], [1, 61], [12.0, 9.0],
    )
    out = weather.parse_daily(payload)
    assert out == {"2026-07-22": {"tmin": 20, "tmax": 30, "code": 1, "wind": 12.0}}


def test_average_climatology_means_temps_and_modal_code():
    y1 = _daily(["2023-07-22"], [30], [20], [1], [10])
    y2 = _daily(["2024-07-22"], [32], [22], [1], [14])
    y3 = _daily(["2025-07-22"], [28], [18], [61], [18])
    out = weather.average_climatology([y1, y2, y3])
    assert out["07-22"]["tmax"] == 30.0      # mean(30,32,28)
    assert out["07-22"]["tmin"] == 20.0      # mean(20,22,18)
    assert out["07-22"]["code"] == 1         # modal (1 appears twice)
    assert out["07-22"]["wind"] == 14.0      # mean(10,14,18)


def test_get_weather_uses_forecast_within_horizon():
    today = date(2026, 6, 30)

    def fake_fetch(url):
        assert "api.open-meteo.com/v1/forecast" in url
        assert "windspeed_10m_max" in url
        return _daily(["2026-07-01", "2026-07-02"], [25, 26], [15, 16], [0, 2], [11, 13])

    out = weather.get_weather(48.85, 2.35, "2026-07-01", "2026-07-02",
                              fetch_json=fake_fetch, today=today)
    assert out["2026-07-01"]["source"] == "forecast"
    assert out["2026-07-01"]["icon"] == "☀"
    assert out["2026-07-01"]["wind"] == 11
    assert out["2026-07-02"]["tmax"] == 26


def test_get_weather_uses_climatology_beyond_horizon():
    today = date(2026, 6, 30)

    def fake_fetch(url):
        # Far-future dates: only the archive API should be called
        assert "archive-api.open-meteo.com" in url
        # one calendar day per historical year
        return _daily(["YYYY-07-22".replace("YYYY", url.split("start_date=")[1][:4])],
                      [31], [21], [1])

    out = weather.get_weather(40.66, 16.60, "2026-07-22", "2026-07-22",
                              fetch_json=fake_fetch, today=today)
    assert out["2026-07-22"]["source"] == "climatology"
    assert out["2026-07-22"]["tmax"] == 31.0
    assert out["2026-07-22"]["desc"] == "Mostly clear"


def test_geocode_resolves_place_name():
    def fake_fetch(q):
        assert "Duffy" in q
        return [{"lat": "-35.34", "lon": "149.03"}]

    assert weather.geocode("Duffy, Australia", fetch=fake_fetch) == (-35.34, 149.03)


def test_geocode_returns_none_on_empty_or_failure():
    assert weather.geocode("") is None
    assert weather.geocode("x", fetch=lambda q: []) is None
    def boom(q):
        raise RuntimeError("down")
    assert weather.geocode("x", fetch=boom) is None


def test_strip_invisible_chars_removes_zero_width_unicode():
    # U+200C ZWNJ and U+200B ZERO WIDTH SPACE, as can sneak in from a pasted
    # address — visually identical to the clean string but breaks geocoding
    # if passed through as-is (Nominatim 400s on it).
    dirty = "75 Airport Boulevard‌ ​Singapore 819664"
    assert weather.strip_invisible_chars(dirty) == "75 Airport Boulevard Singapore 819664"


def test_geocode_strips_invisible_chars_before_fetching():
    dirty = "75 Airport Boulevard‌ ​Singapore 819664"

    def fake_fetch(q):
        assert "‌" not in q and "​" not in q
        return [{"lat": "1.36", "lon": "103.99"}]

    assert weather.geocode(dirty, fetch=fake_fetch) == (1.36, 103.99)


def test_get_weather_bad_coords_returns_empty():
    assert weather.get_weather("nope", "nope", "2026-07-22", "2026-07-23") == {}


def test_utc_today_uses_utc_regardless_of_process_local_clock(monkeypatch):
    # Regression: production's server OS timezone is Europe/Berlin, not UTC.
    # utc_today() must derive its date via datetime.now(timezone.utc) — not
    # date.today(), which follows whatever timezone the *process* happens to
    # run under and would silently disagree with Open-Meteo's UTC-anchored
    # clock during the daily window where the two dates differ (exactly the
    # bug already fixed once for destination-local time, reintroduced via a
    # non-UTC server clock instead).
    class FakeDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            assert tz is timezone.utc
            return datetime(2026, 7, 6, 23, 30, tzinfo=timezone.utc)

    monkeypatch.setattr(weather, "datetime", FakeDateTime)
    assert weather.utc_today() == date(2026, 7, 6)


def test_get_weather_horizon_last_forecast_day_is_today_plus_15():
    # Open-Meteo counts today as day 0, so FORECAST_HORIZON_DAYS=16 total days of
    # live forecast reach only to today+15 (confirmed against the real API, which
    # 400s past that). today+16 must fall back to climatology instead.
    today = date(2026, 7, 6)

    def fake_fetch(url):
        if "archive-api.open-meteo.com" in url:
            return _daily(["2020-07-22"], [31], [21], [1])
        assert "end_date=2026-07-21" in url
        return _daily(["2026-07-21"], [30], [20], [0], [5])

    out = weather.get_weather(1.35, 103.82, "2026-07-21", "2026-07-22",
                              fetch_json=fake_fetch, today=today)
    assert out["2026-07-21"]["source"] == "forecast"
    assert out["2026-07-22"]["source"] == "climatology"


def test_get_weather_uses_server_clock_when_not_overridden(monkeypatch):
    # No `today` kwarg passed — get_weather must fall back to utc_today(),
    # matching Open-Meteo's own UTC-anchored validity window, rather than the
    # destination's local time (or the process's own OS-configured timezone,
    # which production runs as Europe/Berlin, not UTC — date.today() would
    # silently reintroduce the same bug via a different vector). Confirmed
    # directly against the live API that its start_date/end_date bounds are
    # anchored to its own UTC clock regardless of the queried location's
    # timezone — an earlier version of this code used destination-local time
    # instead, which made an eastern destination's computed horizon run ahead
    # of Open-Meteo's real boundary for part of each day, causing whole
    # batched requests to be rejected and fall back to climatology even for
    # in-range dates.
    monkeypatch.setattr(weather, "utc_today", lambda: date(2026, 7, 6))

    def fake_fetch(url):
        assert "start_date=2026-07-06" in url
        return _daily(["2026-07-06"], [30], [20], [0], [5])

    out = weather.get_weather(1.35, 103.82, "2026-07-06", "2026-07-06", fetch_json=fake_fetch)
    assert out["2026-07-06"]["source"] == "forecast"


def test_get_weather_handles_fetch_failure_gracefully():
    today = date(2026, 6, 30)

    def boom(url):
        raise RuntimeError("network down")

    out = weather.get_weather(40.66, 16.60, "2026-07-22", "2026-07-23",
                              fetch_json=boom, today=today)
    assert out == {}


def test_get_weather_forecast_retries_once_then_succeeds():
    # A transient failure on the first attempt must not immediately drop the
    # whole batch to climatology — one immediate retry is tried first.
    today = date(2026, 6, 30)
    calls = {"n": 0}

    def flaky(url):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient blip")
        assert "api.open-meteo.com/v1/forecast" in url
        return _daily(["2026-07-01"], [25], [15], [0], [11])

    out = weather.get_weather(48.85, 2.35, "2026-07-01", "2026-07-01",
                              fetch_json=flaky, today=today)
    assert calls["n"] == 2
    assert out["2026-07-01"]["source"] == "forecast"
    assert out["2026-07-01"]["tmax"] == 25


def test_get_weather_forecast_falls_back_to_climatology_after_two_failures():
    # If both the initial attempt and the single retry fail, the in-horizon
    # date must fall back to climatology rather than raising or being silently
    # dropped from the payload — but only after actually trying twice.
    today = date(2026, 6, 30)
    fc_calls = {"n": 0}

    def fetch(url):
        if "api.open-meteo.com/v1/forecast" in url:
            fc_calls["n"] += 1
            raise RuntimeError("still down")
        assert "archive-api.open-meteo.com" in url
        return _daily(["2020-07-01"], [30], [20], [1])

    out = weather.get_weather(48.85, 2.35, "2026-07-01", "2026-07-01",
                              fetch_json=fetch, today=today)
    assert fc_calls["n"] == 2  # initial attempt + one retry, no more
    assert out["2026-07-01"]["source"] == "climatology"


# ── Hourly detail (click-through) ───────────────────────────────────────────

def _hourly_payload(day="2026-07-01", n_hours=3):
    times = [f"{day}T{h:02d}:00" for h in range(n_hours)]
    return {
        "hourly": {
            "time": times,
            "temperature_2m": [20.0, 19.5, 19.0][:n_hours],
            "apparent_temperature": [19.0, 18.5, 18.0][:n_hours],
            "precipitation_probability": [10, 20, 30][:n_hours],
            "weathercode": [0, 1, 61][:n_hours],
            "relativehumidity_2m": [55, 60, 65][:n_hours],
            "windspeed_10m": [12.0, 14.0, 9.0][:n_hours],
            "uv_index": [0.0, 0.5, 1.0][:n_hours],
        },
        "daily": {
            "sunrise": [f"{day}T06:12"],
            "sunset": [f"{day}T20:45"],
            "uv_index_max": [6.2],
            "precipitation_sum": [0.4],
            "precipitation_probability_max": [30],
        },
    }


def test_hourly_available_within_horizon_only():
    today = date(2026, 6, 30)
    assert weather.hourly_available(today, today) is True
    assert weather.hourly_available(today + timedelta(days=15), today) is True
    assert weather.hourly_available(today + timedelta(days=16), today) is False
    assert weather.hourly_available(today - timedelta(days=1), today) is False


def test_parse_hourly_builds_hours_and_daily_extras():
    day = date(2026, 7, 1)
    out = weather.parse_hourly(_hourly_payload(), day)
    assert out["date"] == "2026-07-01"
    assert len(out["hourly"]) == 3
    assert out["hourly"][0] == {
        "time": "00:00", "temp": 20.0, "feels_like": 19.0, "precip_prob": 10,
        "humidity": 55, "wind": 12.0, "uv": 0.0, "icon": "☀", "desc": "Clear",
    }
    assert out["hourly"][2]["icon"] == "🌧"  # code 61 = light rain
    assert out["sunrise"] == "06:12"
    assert out["sunset"] == "20:45"
    assert out["uv_max"] == 6.2
    assert out["precip_sum"] == 0.4
    assert out["precip_prob_max"] == 30


def test_parse_hourly_returns_none_when_time_series_empty():
    assert weather.parse_hourly({"hourly": {"time": []}}, date(2026, 7, 1)) is None
    assert weather.parse_hourly({}, date(2026, 7, 1)) is None


def test_get_hourly_forecast_outside_horizon_returns_none_without_fetching():
    today = date(2026, 6, 30)
    calls = {"n": 0}

    def fetch(url):
        calls["n"] += 1
        return _hourly_payload()

    out = weather.get_hourly_forecast(48.85, 2.35, today + timedelta(days=20),
                                      fetch_json=fetch, today=today)
    assert out is None
    assert calls["n"] == 0


def test_get_hourly_forecast_fetches_within_horizon():
    today = date(2026, 6, 30)

    def fetch(url):
        assert "api.open-meteo.com/v1/forecast" in url
        assert "hourly=" in url
        assert "start_date=2026-07-01&end_date=2026-07-01" in url
        return _hourly_payload()

    out = weather.get_hourly_forecast(48.85, 2.35, date(2026, 7, 1),
                                      fetch_json=fetch, today=today)
    assert out["date"] == "2026-07-01"
    assert len(out["hourly"]) == 3


def test_get_hourly_forecast_retries_once_then_gives_up():
    today = date(2026, 6, 30)
    calls = {"n": 0}

    def flaky(url):
        calls["n"] += 1
        raise RuntimeError("blip")

    out = weather.get_hourly_forecast(48.85, 2.35, date(2026, 7, 1),
                                      fetch_json=flaky, today=today)
    assert out is None
    assert calls["n"] == 2


def test_get_hourly_forecast_bad_coords_returns_none():
    today = date(2026, 6, 30)
    out = weather.get_hourly_forecast("nope", "nope", date(2026, 7, 1), today=today)
    assert out is None
