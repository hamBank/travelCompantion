"""Tests for Claude-based enhancement of laundry facility data."""
import json
import pytest
from backend.routers.items import _apply_claude_enhancements, _make_wash_entry


def _entries():
    return [
        _make_wash_entry("LavoParis", "5 Rue X", rating=4.1, distance_m=200),
        _make_wash_entry("QuickWash", "12 Ave Y", rating=3.8, distance_m=450),
    ]


def test_apply_enhancements_fills_missing_fields():
    entries = _entries()
    raw = [
        {"index": 0, "cash_card": "Both", "detergent_included": True,
         "open_24hrs": False, "key_notes": "8 machines", "warnings": ""},
        {"index": 1, "cash_card": "Cash only", "detergent_included": False,
         "open_24hrs": True, "key_notes": "", "warnings": "Nearest ATM 300m"},
    ]
    result = _apply_claude_enhancements(entries, raw)
    assert result[0]["cash_card"] == "Both"
    assert result[0]["detergent_included"] is True
    assert result[0]["key_notes"] == "8 machines"
    assert result[1]["cash_card"] == "Cash only"
    assert result[1]["open_24hrs"] is True
    assert result[1]["warnings"] == "Nearest ATM 300m"


def test_apply_enhancements_skips_bad_index():
    entries = _entries()
    raw = [{"index": 99, "cash_card": "Both"}]   # out of range
    result = _apply_claude_enhancements(entries, raw)
    assert result[0]["cash_card"] is None          # unchanged


def test_apply_enhancements_does_not_override_known_open_24hrs():
    entries = _entries()
    entries[0]["open_24hrs"] = True   # already confirmed
    raw = [{"index": 0, "open_24hrs": False, "cash_card": None,
            "detergent_included": None, "key_notes": "", "warnings": ""}]
    result = _apply_claude_enhancements(entries, raw)
    assert result[0]["open_24hrs"] is True          # not downgraded


def test_apply_enhancements_empty_raw_leaves_entries_unchanged():
    entries = _entries()
    result = _apply_claude_enhancements(entries, [])
    assert all(e["cash_card"] is None for e in result)


def test_reviews_stripped_from_final_entries():
    """Internal _reviews field must not leak into stored data."""
    entries = _entries()
    entries[0]["_reviews"] = "Some review text"
    raw = [{"index": 0, "cash_card": "Both", "detergent_included": True,
            "open_24hrs": False, "key_notes": "", "warnings": ""}]
    result = _apply_claude_enhancements(entries, raw)
    assert "_reviews" not in result[0]
