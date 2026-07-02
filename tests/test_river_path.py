"""Tests for backend/river_path.py — Overpass-based river path estimation
with mocked network (no real Overpass/Nominatim calls)."""
from backend import river_path as rp


def _way(*points):
    """points: list of (lat, lng) tuples → an Overpass-style 'way' element."""
    return {"type": "way", "geometry": [{"lat": p[0], "lon": p[1]} for p in points]}


def _overpass_response(*ways):
    return {"elements": list(ways)}


# ── haversine_km ─────────────────────────────────────────────────────────────

def test_haversine_km_zero_for_same_point():
    assert rp.haversine_km((45.0, 4.0), (45.0, 4.0)) == 0.0


def test_haversine_km_reasonable_for_known_distance():
    # Roughly 111km per degree of latitude
    d = rp.haversine_km((0.0, 0.0), (1.0, 0.0))
    assert 110 < d < 112


# ── _merge_ways (stitching) ──────────────────────────────────────────────────

def test_merge_ways_stitches_matching_endpoints_in_order():
    way1 = [(45.0, 4.0), (45.05, 4.1), (45.1, 4.2)]
    way2 = [(45.1, 4.2), (45.15, 4.3), (45.2, 4.4)]  # exact endpoint match
    merged = rp._merge_ways([way1, way2])
    assert len(merged) == 1
    assert merged[0] == way1 + way2[1:]


def test_merge_ways_stitches_within_tolerance_even_if_reversed():
    way1 = [(45.0, 4.0), (45.05, 4.1), (45.1, 4.2)]
    way2 = [(45.2, 4.4), (45.15, 4.3), (45.1001, 4.2001)]  # reversed, tiny gap
    merged = rp._merge_ways([way1, way2])
    assert len(merged) == 1
    assert merged[0][0] == way1[0]
    assert merged[0][-1] == way2[0]  # (45.2, 4.4) — way2 was reversed to attach


def test_merge_ways_does_not_stitch_across_a_large_gap():
    way1 = [(45.0, 4.0), (45.1, 4.2)]
    way2 = [(50.0, 10.0), (50.1, 10.2)]  # hundreds of km away
    merged = rp._merge_ways([way1, way2])
    assert len(merged) == 2


# ── _slice_between ───────────────────────────────────────────────────────────

def test_slice_between_forward():
    pl = [(0, i) for i in range(10)]
    assert rp._slice_between(pl, 2, 5) == pl[2:6]


def test_slice_between_reversed_indices():
    pl = [(0, i) for i in range(10)]
    result = rp._slice_between(pl, 7, 3)
    assert result == list(reversed(pl[3:8]))


# ── _pick_best_polyline ──────────────────────────────────────────────────────

def test_pick_best_polyline_chooses_closest_to_both_endpoints():
    near = [(45.0, 4.0), (45.1, 4.2)]
    far = [(60.0, 20.0), (60.1, 20.2)]
    origin, dest = (45.0, 4.0), (45.1, 4.2)
    best = rp._pick_best_polyline([far, near], origin, dest)
    assert best[0] == near


def test_pick_best_polyline_none_for_empty_list():
    assert rp._pick_best_polyline([], (0, 0), (1, 1)) is None


# ── _simplify ─────────────────────────────────────────────────────────────────

def test_simplify_noop_under_limit():
    pts = [(0, i) for i in range(10)]
    assert rp._simplify(pts, max_points=300) == pts


def test_simplify_decimates_and_keeps_last_point():
    pts = [(0, i) for i in range(1000)]
    result = rp._simplify(pts, max_points=100)
    assert len(result) <= 101  # stride decimation + explicit last-point append
    assert result[0] == pts[0]
    assert result[-1] == pts[-1]


# ── build_overpass_query ──────────────────────────────────────────────────────

def test_build_overpass_query_includes_name_filter_when_given():
    q = rp.build_overpass_query((0, 0, 1, 1), river_name="Rhône")
    assert 'waterway"~"^(river|canal)$"' in q
    assert '"name"~"Rhône",i' in q
    assert "0,0,1,1" in q


def test_build_overpass_query_omits_name_filter_when_absent():
    q = rp.build_overpass_query((0, 0, 1, 1), river_name=None)
    assert '"name"~' not in q


def test_build_overpass_query_strips_quote_injection_from_river_name():
    q = rp.build_overpass_query((0, 0, 1, 1), river_name='Rhô"ne\\')
    assert '\\' not in q.split('"name"~"')[1].split('"')[0]


# ── estimate_river_path (integration of the above) ───────────────────────────

def _two_leg_river():
    """A simple two-way river running from ~(45.0,4.0) to ~(45.2,4.4)."""
    return [
        _way((45.0, 4.0), (45.05, 4.1), (45.1, 4.2)),
        _way((45.1, 4.2), (45.15, 4.3), (45.2, 4.4)),
    ]


def test_estimate_river_path_happy_path_with_named_river():
    def fake_fetch(query):
        assert "Rhône" in query or "Rh" in query  # name filter present
        return _overpass_response(*_two_leg_river())

    result = rp.estimate_river_path(
        "45.001,4.001", "45.199,4.399", river_name="Rhône", fetch_json=fake_fetch,
    )
    assert result is not None
    assert len(result["path"]) >= 2
    assert result["path"][0] == [45.0, 4.0] or rp.haversine_km(tuple(result["path"][0]), (45.001, 4.001)) < 1
    assert result["distance_km"] > 0
    assert result["river_name_used"] == "Rhône"


def test_estimate_river_path_geocodes_place_names():
    calls = []

    def fake_geocode(q):
        calls.append(q)
        return {"Lyon": (45.001, 4.001), "Valence": (45.199, 4.399)}[q]

    def fake_fetch(query):
        return _overpass_response(*_two_leg_river())

    result = rp.estimate_river_path(
        "Lyon", "Valence", fetch_json=fake_fetch, geocode=fake_geocode,
    )
    assert result is not None
    assert calls == ["Lyon", "Valence"]


def test_estimate_river_path_raises_when_geocoding_fails():
    import pytest

    def fake_geocode(q):
        return None

    with pytest.raises(rp.NoPlausiblePath):
        rp.estimate_river_path(
            "Nowhereville", "Valence", fetch_json=lambda q: {}, geocode=fake_geocode,
        )


def test_estimate_river_path_raises_for_points_too_far_apart():
    import pytest
    with pytest.raises(ValueError):
        rp.estimate_river_path("0,0", "40,40", fetch_json=lambda q: {})


def test_estimate_river_path_falls_back_to_broad_query_when_named_empty():
    calls = []

    def fake_fetch(query):
        calls.append(query)
        if '"name"~' in query:
            return _overpass_response()  # named query: nothing found
        return _overpass_response(*_two_leg_river())

    result = rp.estimate_river_path(
        "45.001,4.001", "45.199,4.399", river_name="Nonexistent River", fetch_json=fake_fetch,
    )
    assert len(calls) == 2  # named attempt, then broad fallback
    assert result is not None
    assert result["river_name_used"] is None  # broad fallback used, name not confirmed


def test_estimate_river_path_raises_when_no_ways_found_at_all():
    import pytest
    with pytest.raises(rp.NoPlausiblePath, match="No waterway data found"):
        rp.estimate_river_path(
            "45.001,4.001", "45.199,4.399", river_name="Nonexistent River",
            fetch_json=lambda q: _overpass_response(),
        )


def test_estimate_river_path_raises_when_points_far_from_any_candidate():
    import pytest
    # The river runs nowhere near the requested origin/destination.
    def fake_fetch(query):
        return _overpass_response(*_two_leg_river())

    with pytest.raises(rp.NoPlausiblePath, match="couldn't connect"):
        rp.estimate_river_path("10.0,10.0", "10.2,10.4", fetch_json=fake_fetch)


def test_estimate_river_path_falls_back_to_broad_when_named_ways_dont_reach_endpoints():
    """A named-filtered query can return ways that exist but are nowhere near
    the requested points (e.g. a same-named tributary fragment elsewhere in
    the bbox) — this must retry broad, not just when the named query is
    literally empty."""
    calls = []

    def fake_fetch(query):
        calls.append(query)
        if '"name"~' in query:
            return _overpass_response(_way((10.0, 10.0), (10.01, 10.01)))
        return _overpass_response(*_two_leg_river())

    result = rp.estimate_river_path(
        "45.001,4.001", "45.199,4.399", river_name="Rhône", fetch_json=fake_fetch,
    )
    assert len(calls) == 2  # named attempt failed to connect, then broad fallback
    assert result is not None
    assert result["river_name_used"] is None


def test_estimate_river_path_bridges_gap_beyond_strict_stitch_tolerance():
    """Locks/weirs on a channelized river often split the waterway tag with a
    gap wider than the strict stitch tolerance — the bridge-tolerance retry
    pass should still connect the two legs into one path reaching both ends.
    Each leg is long enough (~9 km) that neither one alone satisfies the
    origin/destination snap tolerance (8 km) on its own — otherwise the
    strict pass would "succeed" early with a truncated, unbridged chain."""
    way1 = [(45.000, 4.000), (45.081081, 4.000)]    # ~9 km leg
    way2 = [(45.090090, 4.000), (45.171081, 4.000)]  # ~1 km gap, then another ~9 km leg

    def fake_fetch(query):
        return _overpass_response(_way(*way1), _way(*way2))

    result = rp.estimate_river_path("45.000,4.000", "45.171081,4.000", fetch_json=fake_fetch)
    assert result is not None
    assert rp.haversine_km(tuple(result["path"][0]), (45.000, 4.000)) < 1
    assert rp.haversine_km(tuple(result["path"][-1]), (45.171081, 4.000)) < 1


def test_estimate_river_path_accepts_town_center_offset_from_riverbank():
    """A geocoded town center can be several km from the actual quay/channel
    — regression test for a real-world near miss (5.7 km from one endpoint,
    2.9 km from the other) that the old 5 km snap tolerance rejected."""
    river = [(45.000, 4.000), (45.100, 4.000)]

    def fake_fetch(query):
        return _overpass_response(_way(*river))

    origin = "45.000,4.0726"       # ~5.7 km east of the river's start
    destination = "45.100,4.0369"  # ~2.9 km east of the river's end
    result = rp.estimate_river_path(origin, destination, fetch_json=fake_fetch)
    assert result is not None


def test_estimate_river_path_rejects_too_many_unnamed_ways():
    import pytest

    def fake_fetch(query):
        # Oversized ambiguous result with no name filter to narrow it down.
        ways = [_way((45.0 + i * 0.001, 4.0), (45.0 + i * 0.001, 4.001)) for i in range(rp.MAX_WAYS + 1)]
        return _overpass_response(*ways)

    with pytest.raises(rp.NoPlausiblePath, match="too ambiguous"):
        rp.estimate_river_path("45.001,4.001", "45.199,4.399", fetch_json=fake_fetch)
