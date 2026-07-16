"""Tests for backend/tz_check.py — offset parsing/comparison and the location
timezone cache (resolution itself is stubbed via injected geocode/fetch_json)."""
from datetime import date

from sqlmodel import Session

from backend import tz_check


# ── parse_stored_offset_minutes ─────────────────────────────────────────────

def test_parses_gmt_plus_offset():
    assert tz_check.parse_stored_offset_minutes("GMT+2", date(2026, 8, 4)) == 120


def test_parses_gmt_minus_offset():
    assert tz_check.parse_stored_offset_minutes("GMT-5", date(2026, 8, 4)) == -300


def test_parses_colon_minute_offset():
    assert tz_check.parse_stored_offset_minutes("+05:30", date(2026, 8, 4)) == 330


def test_parses_bare_iana_zone_name_dst_aware():
    # Europe/Rome is GMT+1 in January, GMT+2 in August (CEST) — same zone,
    # different real offset depending on the date, unlike a fixed "GMT+2" string.
    assert tz_check.parse_stored_offset_minutes("Europe/Rome", date(2026, 8, 4)) == 120
    assert tz_check.parse_stored_offset_minutes("Europe/Rome", date(2026, 1, 4)) == 60


def test_returns_none_for_empty_or_garbage():
    assert tz_check.parse_stored_offset_minutes("", date(2026, 8, 4)) is None
    assert tz_check.parse_stored_offset_minutes(None, date(2026, 8, 4)) is None
    assert tz_check.parse_stored_offset_minutes("Narnia/Nowhere", date(2026, 8, 4)) is None


# ── parse_stop_offset_minutes ────────────────────────────────────────────────

def test_parses_plain_hour_string():
    assert tz_check.parse_stop_offset_minutes("2") == 120
    assert tz_check.parse_stop_offset_minutes("-5") == -300


def test_parses_half_hour_offset():
    assert tz_check.parse_stop_offset_minutes("5.5") == 330


def test_parses_zero_as_zero_not_none():
    # Distinguishing "0" (unset) from a real 0 is the caller's job
    # (Stop.timezone's model default is "0"); this function just parses.
    assert tz_check.parse_stop_offset_minutes("0") == 0


def test_stop_offset_returns_none_for_garbage():
    assert tz_check.parse_stop_offset_minutes("") is None
    assert tz_check.parse_stop_offset_minutes(None) is None
    assert tz_check.parse_stop_offset_minutes("GMT+2") is None


# ── expected_offset_minutes ──────────────────────────────────────────────────

def test_expected_offset_is_dst_aware():
    assert tz_check.expected_offset_minutes("Europe/Rome", date(2026, 8, 4)) == 120
    assert tz_check.expected_offset_minutes("Europe/Rome", date(2026, 1, 4)) == 60


def test_expected_offset_none_for_unknown_zone():
    assert tz_check.expected_offset_minutes("Not/AZone", date(2026, 8, 4)) is None


# ── geocode_query ─────────────────────────────────────────────────────────────

def test_geocode_query_rephrases_bare_iata_code():
    assert tz_check.geocode_query("FCO") == "FCO airport"


def test_geocode_query_passes_through_place_names():
    assert tz_check.geocode_query("Rome") == "Rome"
    assert tz_check.geocode_query("Nice, France") == "Nice, France"


# ── resolve_iana_zone (geocode/fetch_json injected — no network) ────────────

def test_resolve_iana_zone_chains_geocode_and_fetch():
    def fake_geocode(q):
        assert q == "FCO airport"
        return (41.8, 12.25)

    def fake_fetch_json(url):
        assert "latitude=41.8" in url and "longitude=12.25" in url
        return {"timezone": "Europe/Rome"}

    assert tz_check.resolve_iana_zone("FCO", geocode=fake_geocode, fetch_json=fake_fetch_json) == "Europe/Rome"


def test_resolve_iana_zone_none_when_geocode_fails():
    assert tz_check.resolve_iana_zone("Nowhereville", geocode=lambda q: None) is None


def test_resolve_iana_zone_none_when_timezone_fetch_fails():
    def fake_fetch_json(url):
        raise ConnectionError("boom")
    result = tz_check.resolve_iana_zone("Rome", geocode=lambda q: (41.8, 12.25), fetch_json=fake_fetch_json)
    assert result is None


# ── cache read/write ──────────────────────────────────────────────────────────

def test_get_cached_zone_returns_none_when_unresolved(session: Session):
    assert tz_check.get_cached_zone(session, "Rome") is None


def test_refresh_zone_cache_writes_and_get_cached_zone_reads_it_back(session: Session):
    tz_check.refresh_zone_cache(
        session, "Rome",
        geocode=lambda q: (41.9, 12.5),
        fetch_json=lambda url: {"timezone": "Europe/Rome"},
    )
    session.commit()
    assert tz_check.get_cached_zone(session, "Rome") == "Europe/Rome"


def test_refresh_zone_cache_updates_existing_row_in_place(session: Session):
    tz_check.refresh_zone_cache(session, "Rome", geocode=lambda q: (41.9, 12.5),
                                 fetch_json=lambda url: {"timezone": "Europe/Rome"})
    session.commit()
    tz_check.refresh_zone_cache(session, "Rome", geocode=lambda q: (41.9, 12.5),
                                 fetch_json=lambda url: {"timezone": "Europe/Rome"})
    session.commit()
    from sqlmodel import select
    from backend.models import LocationTimezone
    rows = session.exec(select(LocationTimezone).where(LocationTimezone.location == "Rome")).all()
    assert len(rows) == 1


def test_refresh_zone_cache_returns_none_and_writes_nothing_on_failure(session: Session):
    result = tz_check.refresh_zone_cache(session, "Nowhereville", geocode=lambda q: None)
    session.commit()
    assert result is None
    assert tz_check.get_cached_zone(session, "Nowhereville") is None
