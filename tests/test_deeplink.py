"""Tests for GET /t/{...} — the SPA shell for a copied trip/stop/item deep
link (see backend/routers/deeplink.py and frontend/src/urlPath.js). This
route never touches the database or validates anything about the path; it
just needs to serve the compiled app shell for every path shape the
frontend's URL scheme defines.
"""


def test_bare_trip_link_serves_html(client):
    r = client.get("/t/1")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


def test_day_item_and_stop_links_all_serve_html(client):
    for path in ["/t/1/day/2026-09-16", "/t/1/item/7", "/t/1/stop/9"]:
        r = client.get(path)
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]


def test_a_nonexistent_or_malformed_trip_id_still_serves_html(client):
    # Deliberately does not validate the path at all — the React app
    # resolves (or fails to resolve) the target client-side, same as a
    # stale /shared/{token} link does.
    for path in ["/t/999999", "/t/not-a-number", "/t/1/day/", "/t/1/whatever/x"]:
        r = client.get(path)
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
