"""Tests for GPX-derived route storage and the /items/{id}/gpx-map endpoint.

These cover the walk card's map: it should trace the actual uploaded/recorded
GPX track (details.gpx_route) instead of only ever falling back to a Google
Directions embed recomputed between named waypoints.
"""
import io
import pytest
from backend.routers import items as items_mod
from backend.routers.items import _decimate_coords, _encode_polyline

_GPX_WITH_ELEVATION = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">'
    '<trk><name>Coastal trail</name><trkseg>'
    '<trkpt lat="41.9000" lon="12.5000"><ele>10</ele></trkpt>'
    '<trkpt lat="41.9010" lon="12.5010"><ele>15</ele></trkpt>'
    '<trkpt lat="41.9020" lon="12.5020"><ele>12</ele></trkpt>'
    '</trkseg></trk></gpx>'
).encode()


@pytest.fixture(autouse=True)
def isolate_gpx_dir(monkeypatch, tmp_path):
    """Upload endpoints write the .gpx file to disk — redirect to a temp dir
    so tests don't leave real files behind in the project's uploads/ folder."""
    monkeypatch.setattr(items_mod, "_GPX_DIR", str(tmp_path))


@pytest.fixture
def walk_item(client):
    trip = client.post("/trips/", json={"name": "Test Trip"}).json()
    stop = client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "status": "planned"
    }).json()
    return client.post(f"/stops/{stop['id']}/items", json={
        "kind": "walk", "name": "Coastal trail", "status": "pending",
        "details": {"start_location": "Rome A", "end_location": "Rome B"},
    }).json()


class FakeStaticMapsClient:
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url):
        self.__class__.last_url = url
        class R:
            content = b"\x89PNG\r\n\x1a\nfakebytes"
            def raise_for_status(self): pass
        return R()


def test_decimate_coords_keeps_short_lists_unchanged():
    coords = [(0, 0, None), (1, 1, None), (2, 2, None)]
    assert _decimate_coords(coords, max_points=300) == coords


def test_decimate_coords_caps_length_and_preserves_endpoints():
    coords = [(i, i, None) for i in range(1000)]
    result = _decimate_coords(coords, max_points=100)
    assert len(result) == 100
    assert result[0] == coords[0]
    assert result[-1] == coords[-1]


def test_upload_gpx_stores_gpx_route(client, session, walk_item):
    r = client.post(
        f"/items/{walk_item['id']}/gpx",
        files={"file": ("trail.gpx", io.BytesIO(_GPX_WITH_ELEVATION), "application/gpx+xml")},
    )
    assert r.status_code == 200
    route = r.json()["details"]["gpx_route"]
    assert route == [[41.9, 12.5], [41.901, 12.501], [41.902, 12.502]]


def test_gpx_map_404_when_no_route_stored(client, session, walk_item):
    r = client.get(f"/items/{walk_item['id']}/gpx-map")
    assert r.status_code == 404
    assert "No GPX route" in r.json()["detail"]


def test_gpx_map_503_when_key_not_configured(client, session, walk_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_STATIC_MAPS_KEY", "")
    client.post(
        f"/items/{walk_item['id']}/gpx",
        files={"file": ("trail.gpx", io.BytesIO(_GPX_WITH_ELEVATION), "application/gpx+xml")},
    )
    r = client.get(f"/items/{walk_item['id']}/gpx-map")
    assert r.status_code == 503


def test_gpx_map_happy_path_traces_the_actual_recorded_points(client, session, walk_item, monkeypatch):
    monkeypatch.setattr(items_mod, "_STATIC_MAPS_KEY", "test-key")
    monkeypatch.setattr(items_mod.httpx, "Client", FakeStaticMapsClient)

    client.post(
        f"/items/{walk_item['id']}/gpx",
        files={"file": ("trail.gpx", io.BytesIO(_GPX_WITH_ELEVATION), "application/gpx+xml")},
    )
    r = client.get(f"/items/{walk_item['id']}/gpx-map")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"

    expected_enc = _encode_polyline([(41.9, 12.5), (41.901, 12.501), (41.902, 12.502)])
    assert expected_enc in FakeStaticMapsClient.last_url
    assert "key=test-key" in FakeStaticMapsClient.last_url
    # Start/end markers still included, same convention as river-map.
    assert "label%3AA" in FakeStaticMapsClient.last_url
    assert "label%3AB" in FakeStaticMapsClient.last_url
