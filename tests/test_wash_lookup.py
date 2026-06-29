"""Tests for accommodation laundry facility lookup."""
import pytest
from backend.routers.items import _make_wash_entry, _mark_top_picks


def test_make_wash_entry_defaults():
    e = _make_wash_entry("Wash & Go", "123 High St")
    assert e["name"] == "Wash & Go"
    assert e["address"] == "123 High St"
    assert e["top_pick"] is False
    assert e["open_24hrs"] is False
    assert e["cash_card"] is None
    assert e["detergent_included"] is None
    assert e["key_notes"] == ""
    assert e["warnings"] == ""


def test_make_wash_entry_with_optional_fields():
    e = _make_wash_entry("LavoParis", "5 Rue X", rating=4.3, review_count=120,
                         distance_m=350, open_24hrs=True, hours="08:00–22:00")
    assert e["rating"] == 4.3
    assert e["review_count"] == 120
    assert e["distance_m"] == 350
    assert e["open_24hrs"] is True
    assert e["hours"] == "08:00–22:00"


def test_mark_top_picks_selects_highest_rated_within_500m():
    entries = [
        _make_wash_entry("A", "a", rating=3.5, distance_m=200),
        _make_wash_entry("B", "b", rating=4.8, distance_m=400),
        _make_wash_entry("C", "c", rating=5.0, distance_m=600),  # outside 500m
    ]
    result = _mark_top_picks(entries)
    assert result[1]["top_pick"] is True    # B: best rated within 500m
    assert result[0]["top_pick"] is False
    assert result[2]["top_pick"] is False   # C outside threshold


def test_mark_top_picks_closest_when_no_ratings():
    entries = [
        _make_wash_entry("Near", "n", rating=None, distance_m=150),
        _make_wash_entry("Far",  "f", rating=None, distance_m=400),
    ]
    result = _mark_top_picks(entries)
    assert result[0]["top_pick"] is True   # nearest when no ratings


def test_mark_top_picks_empty_list():
    assert _mark_top_picks([]) == []


def test_mark_top_picks_single_entry():
    entries = [_make_wash_entry("Solo", "x", distance_m=200)]
    result = _mark_top_picks(entries)
    assert result[0]["top_pick"] is True


def test_wash_lookup_requires_accommodation(client, session, monkeypatch):
    import backend.routers.items as items_mod
    monkeypatch.setattr(items_mod, "_PLACES_KEY", "fake-key")  # bypass 503
    trip = client.post("/trips/", json={"name": "T"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops",
                       json={"location": "Paris", "status": "planned"}).json()
    item = client.post(f"/stops/{stop['id']}/items",
                       json={"kind": "flight", "name": "SIN→CDG",
                             "status": "pending", "details": {}}).json()
    r = client.post(f"/items/{item['id']}/wash-lookup")
    assert r.status_code == 400
    assert "accommodation" in r.json()["detail"]


def test_wash_lookup_endpoint_exists(client, session):
    """Endpoint must be reachable (not 404) even without Places key."""
    trip = client.post("/trips/", json={"name": "T"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops",
                       json={"location": "Paris", "status": "planned",
                             "arrive": "2026-07-27T00:00", "depart": "2026-07-30T00:00"}).json()
    item = client.post(f"/stops/{stop['id']}/items",
                       json={"kind": "accommodation", "name": "Hotel Test",
                             "status": "pending",
                             "details": {"location": "1 Rue de Rivoli, Paris"}}).json()
    r = client.post(f"/items/{item['id']}/wash-lookup")
    # 503 (no API key) is fine — 404 is not
    assert r.status_code != 404
