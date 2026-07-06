"""Tests for backend/tzutil.py — longitude-based local-day approximation."""
from datetime import datetime, timezone

from backend import tzutil


def test_approx_utc_offset_hours_zero_at_prime_meridian():
    assert tzutil.approx_utc_offset_hours(0) == 0


def test_approx_utc_offset_hours_rounds_to_nearest_zone():
    assert tzutil.approx_utc_offset_hours(103.8198) == 7  # Singapore-ish longitude


def test_approx_utc_offset_hours_negative_longitude():
    assert tzutil.approx_utc_offset_hours(-74.0) == -5  # New York-ish longitude


def test_approx_utc_offset_hours_clamps_to_real_limits():
    assert tzutil.approx_utc_offset_hours(300) == 14
    assert tzutil.approx_utc_offset_hours(-300) == -12


def test_local_today_none_lng_uses_now_as_is():
    now = datetime(2026, 7, 6, 23, 0, tzinfo=timezone.utc)
    assert tzutil.local_today(None, now=now) == now.date()


def test_local_today_shifts_forward_for_eastern_longitude():
    # 23:00 UTC on the 6th is already the 7th at Singapore's longitude (+7ish).
    now = datetime(2026, 7, 6, 23, 0, tzinfo=timezone.utc)
    assert tzutil.local_today(103.8198, now=now).isoformat() == "2026-07-07"


def test_local_today_shifts_backward_for_western_longitude():
    # 02:00 UTC on the 7th is still the 6th on the US east coast (-5ish).
    now = datetime(2026, 7, 7, 2, 0, tzinfo=timezone.utc)
    assert tzutil.local_today(-74.0, now=now).isoformat() == "2026-07-06"


def test_local_today_defaults_to_current_time_when_now_not_given():
    # Just confirm it runs and returns a date without error.
    assert tzutil.local_today(0) is not None
