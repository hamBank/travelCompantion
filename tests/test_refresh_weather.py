"""Tests for cache-key helpers and the daily weather refresh."""
import sys
from datetime import datetime, timedelta
from pathlib import Path

from sqlmodel import SQLModel, Session, create_engine, select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import weather  # noqa: E402
from backend.models import WeatherCache  # noqa: E402
from scripts.refresh_weather import refresh_all  # noqa: E402


def test_cache_key_roundtrip_and_rounding():
    key = weather.cache_key("40.666", "16.604", "2026-07-27", "2026-07-28")
    assert key == "v2,40.67,16.6,2026-07-27,2026-07-28"
    assert weather.parse_cache_key(key) == ("40.67", "16.6", "2026-07-27", "2026-07-28")


def test_parse_cache_key_rejects_other_versions():
    assert weather.parse_cache_key("v1,1.0,2.0,2026-07-01,2026-07-02") is None
    assert weather.parse_cache_key("garbage") is None


def test_refresh_all_updates_payload_and_timestamp():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    old_time = datetime.utcnow() - timedelta(days=2)
    key = weather.cache_key("40.66", "16.60", "2026-07-27", "2026-07-27")
    with Session(engine) as s:
        s.add(WeatherCache(cache_key=key, payload={"old": True}, fetched_at=old_time))
        s.commit()

        def fake_get_weather(lat, lng, start, end):
            return {"2026-07-27": {"tmin": 19, "tmax": 32, "wind": 18, "icon": "⛅",
                                   "desc": "Partly cloudy", "source": "climatology"}}

        n = refresh_all(s, get_weather=fake_get_weather)
        assert n == 1

        row = s.exec(select(WeatherCache)).one()
        assert "2026-07-27" in row.payload
        assert row.payload["2026-07-27"]["wind"] == 18
        assert row.fetched_at > old_time


def test_refresh_all_regeocodes_q_keys():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(WeatherCache(cache_key="v2,q:duffy australia,2026-08-20,2026-08-20", payload={}))
        s.commit()

        def fake_geocode(q):
            assert q == "duffy australia"
            return (-35.34, 149.03)

        def fake_get_weather(lat, lng, start, end):
            assert (lat, lng) == (-35.34, 149.03)
            return {"2026-08-20": {"tmin": 2, "tmax": 13}}

        n = refresh_all(s, get_weather=fake_get_weather, geocode=fake_geocode)
        assert n == 1
        row = s.exec(select(WeatherCache)).one()
        assert row.payload["2026-08-20"]["tmax"] == 13


def test_refresh_all_skips_stale_version_keys():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(WeatherCache(cache_key="v1,1.0,2.0,2026-07-01,2026-07-02", payload={"old": True}))
        s.commit()
        n = refresh_all(s, get_weather=lambda *a: {"x": 1})
        assert n == 0  # stale-version key left untouched
