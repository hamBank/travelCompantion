"""Tests for backend/weather.py — forecast + climatology with mocked network."""
from datetime import date

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


def test_get_weather_bad_coords_returns_empty():
    assert weather.get_weather("nope", "nope", "2026-07-22", "2026-07-23") == {}


def test_get_weather_handles_fetch_failure_gracefully():
    today = date(2026, 6, 30)

    def boom(url):
        raise RuntimeError("network down")

    out = weather.get_weather(40.66, 16.60, "2026-07-22", "2026-07-23",
                              fetch_json=boom, today=today)
    assert out == {}
