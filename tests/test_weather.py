"""Tests for backend/weather.py — forecast + climatology with mocked network."""
from datetime import date, datetime, timezone

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
