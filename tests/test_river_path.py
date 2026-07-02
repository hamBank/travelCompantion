"""Tests for backend/river_path.py — Overpass-based river path estimation
with mocked network (no real Overpass/Nominatim calls)."""
import json
import urllib.error
import urllib.request

import pytest

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
    assert result["approximate"] is False


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


def test_estimate_river_path_falls_back_to_straight_line_when_no_ways_found_at_all():
    result = rp.estimate_river_path(
        "45.001,4.001", "45.199,4.399", river_name="Nonexistent River",
        fetch_json=lambda q: _overpass_response(),
    )
    assert result["approximate"] is True
    assert result["path"] == [[45.001, 4.001], [45.199, 4.399]]
    assert result["river_name_used"] is None


def test_estimate_river_path_falls_back_to_straight_line_when_points_far_from_any_candidate():
    # The river runs nowhere near the requested origin/destination.
    def fake_fetch(query):
        return _overpass_response(*_two_leg_river())

    result = rp.estimate_river_path("10.0,10.0", "10.2,10.4", fetch_json=fake_fetch)
    assert result["approximate"] is True
    assert result["path"] == [[10.0, 10.0], [10.2, 10.4]]


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


def test_estimate_river_path_falls_back_to_straight_line_when_too_many_unnamed_ways():
    def fake_fetch(query):
        # Oversized ambiguous result with no name filter to narrow it down.
        ways = [_way((45.0 + i * 0.001, 4.0), (45.0 + i * 0.001, 4.001)) for i in range(rp.MAX_WAYS + 1)]
        return _overpass_response(*ways)

    result = rp.estimate_river_path("45.001,4.001", "45.199,4.399", fetch_json=fake_fetch)
    assert result["approximate"] is True
    assert result["path"] == [[45.001, 4.001], [45.199, 4.399]]


# ── natural=water reservoir bridging ─────────────────────────────────────────

def test_build_water_polygon_query_has_no_name_filter():
    q = rp.build_water_polygon_query((0, 0, 1, 1))
    assert '"natural"="water"' in q
    assert '"name"~' not in q
    assert "0,0,1,1" in q


def test_polygon_ways_from_response_filters_to_closed_rings():
    open_way = _way((0, 0), (0, 1), (0, 2))
    closed_ring = _way((1, 1), (1, 2), (2, 2), (1, 1))
    rings = rp._polygon_ways_from_response(_overpass_response(open_way, closed_ring))
    assert len(rings) == 1
    assert rings[0][0] == rings[0][-1] == (1, 1)


def test_ring_arc_picks_the_shorter_direction():
    # A square ring; going 0->1 the short way is a single edge, the long way is three.
    ring = [(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)]
    assert rp._ring_arc(ring, 0, 1) == [(0, 0), (0, 1)]
    assert rp._ring_arc(ring, 1, 0) == [(0, 1), (0, 0)]


def test_ring_arc_wraps_around_when_that_is_shorter():
    ring = [(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)]
    # From index 3 to index 0: forward wraps immediately (1 step); backward is 3 steps.
    assert rp._ring_arc(ring, 3, 0) == [(1, 0), (0, 0)]


def test_estimate_river_path_bridges_a_reservoir_polygon_gap():
    """Reproduces a real report: a dammed/impounded stretch of river is
    mapped as a natural=water lake polygon rather than a waterway line, so
    the line-only search reaches one endpoint but dangles ~20km short of
    the other. A nearby water polygon should bridge the gap."""
    line_way = [(0.0, 0.0), (0.0, 0.5)]
    # A small diamond-shaped "reservoir" spanning from the line's dangling
    # end to the actual destination.
    reservoir = [(0.0, 0.5), (0.01, 0.6), (0.0, 0.7), (-0.01, 0.6), (0.0, 0.5)]

    def fake_fetch(query):
        if '"natural"="water"' in query:
            return _overpass_response(_way(*reservoir))
        return _overpass_response(_way(*line_way))

    result = rp.estimate_river_path("0.0,0.0", "0.0,0.7", fetch_json=fake_fetch)
    assert result is not None
    assert result["path"][0] == [0.0, 0.0]
    assert result["path"][-1] == [0.0, 0.7]


def test_estimate_river_path_falls_back_to_straight_line_when_no_reservoir_bridges_the_gap():
    line_way = [(0.0, 0.0), (0.0, 0.5)]

    def fake_fetch(query):
        if '"natural"="water"' in query:
            return _overpass_response()  # no polygon data at all
        return _overpass_response(_way(*line_way))

    result = rp.estimate_river_path("0.0,0.0", "0.0,0.7", fetch_json=fake_fetch)
    assert result["approximate"] is True
    assert result["path"] == [[0.0, 0.0], [0.0, 0.7]]


# ── external-call metrics (default network functions) ───────────────────────

class _FakeUrlResponse:
    def __init__(self, body: bytes):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_default_fetch_overpass_records_success(monkeypatch):
    calls = []
    monkeypatch.setattr(rp, "record_external_call", lambda *a, **k: calls.append((a, k)))
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: _FakeUrlResponse(b'{"elements": []}'))

    result = rp._default_fetch_overpass("fake query")
    assert result == {"elements": []}
    assert calls == [(("overpass",), {"ok": True})]


def test_default_fetch_overpass_records_failure_and_reraises(monkeypatch):
    calls = []
    monkeypatch.setattr(rp, "record_external_call", lambda *a, **k: calls.append((a, k)))

    def raise_429(req, timeout=None):
        raise urllib.error.HTTPError("url", 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(urllib.request, "urlopen", raise_429)

    with pytest.raises(urllib.error.HTTPError):
        rp._default_fetch_overpass("fake query")
    assert len(calls) == 1
    assert calls[0][0] == ("overpass",)
    assert calls[0][1]["ok"] is False


def test_default_geocode_records_success(monkeypatch):
    calls = []
    monkeypatch.setattr(rp, "record_external_call", lambda *a, **k: calls.append((a, k)))
    body = json.dumps([{"lat": "45.0", "lon": "4.0"}]).encode()
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: _FakeUrlResponse(body))

    result = rp._default_geocode("Lyon")
    assert result == (45.0, 4.0)
    assert calls == [(("nominatim",), {"ok": True})]


def test_default_geocode_records_failure_and_reraises(monkeypatch):
    calls = []
    monkeypatch.setattr(rp, "record_external_call", lambda *a, **k: calls.append((a, k)))

    def raise_error(req, timeout=None):
        raise OSError("network unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", raise_error)

    with pytest.raises(OSError):
        rp._default_geocode("Lyon")
    assert calls == [(("nominatim",), {"ok": False, "error": "network unreachable"})]
