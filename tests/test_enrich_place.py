"""Tests for the pre-save Google Places autofill endpoint (/stops/{id}/enrich)."""
import pytest
from backend.routers import items as items_mod


@pytest.fixture
def stop(client):
    trip = client.post("/trips/", json={"name": "Test Trip"}).json()
    return client.post(f"/trips/{trip['id']}/stops", json={
        "location": "Rome", "status": "planned"
    }).json()


class FakeClient:
    """Mimics httpx.Client for the two sequential Places API calls."""
    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False

    def get(self, url, params=None):
        if "findplacefromtext" in url:
            self.captured_input = params["input"]
            return _FakeResponse({"candidates": [{"place_id": "abc123"}]})
        assert "details" in url
        return _FakeResponse({"result": {
            "formatted_address": "Via Roma 1, Rome",
            "formatted_phone_number": "+39 06 123456",
            "website": "https://trattoria.example",
            "editorial_summary": {"overview": "Cozy trattoria near the centre."},
        }})


class _FakeResponse:
    def __init__(self, data): self._data = data
    def json(self): return self._data


def test_enrich_place_503_when_key_not_configured(client, session, stop):
    r = client.get(f"/stops/{stop['id']}/enrich", params={"kind": "activity", "name": "Foo"})
    assert r.status_code == 503


def test_enrich_place_400_for_non_enrichable_kind(client, session, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_PLACES_KEY", "fake-key")
    r = client.get(f"/stops/{stop['id']}/enrich", params={"kind": "flight", "name": "Foo"})
    assert r.status_code == 400
    assert "not enrichable" in r.json()["detail"]


def test_enrich_place_400_when_name_blank(client, session, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_PLACES_KEY", "fake-key")
    r = client.get(f"/stops/{stop['id']}/enrich", params={"kind": "activity", "name": "  "})
    assert r.status_code == 400
    assert "Name is required" in r.json()["detail"]


def test_enrich_place_404_when_stop_not_found(client, session, monkeypatch):
    monkeypatch.setattr(items_mod, "_PLACES_KEY", "fake-key")
    r = client.get("/stops/99999/enrich", params={"kind": "activity", "name": "Foo"})
    assert r.status_code == 404


def test_enrich_place_404_when_place_not_found(client, session, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_PLACES_KEY", "fake-key")

    class EmptyClient(FakeClient):
        def get(self, url, params=None):
            if "findplacefromtext" in url:
                return _FakeResponse({"candidates": []})
            return _FakeResponse({"result": {}})

    monkeypatch.setattr(items_mod.httpx, "Client", EmptyClient)
    r = client.get(f"/stops/{stop['id']}/enrich", params={"kind": "restaurant", "name": "Nowhere"})
    assert r.status_code == 404


def test_enrich_place_happy_path_combines_name_and_location(client, session, stop, monkeypatch):
    monkeypatch.setattr(items_mod, "_PLACES_KEY", "fake-key")
    fake = FakeClient()
    monkeypatch.setattr(items_mod.httpx, "Client", lambda *a, **k: fake)

    r = client.get(f"/stops/{stop['id']}/enrich", params={
        "kind": "restaurant", "name": "Trattoria da Mario", "location": "Rome",
    })
    assert r.status_code == 200
    assert fake.captured_input == "Trattoria da Mario Rome"
    body = r.json()
    assert body["location"] == "Via Roma 1, Rome"
    assert body["contact_phone"] == "+39 06 123456"
    assert body["website"] == "https://trattoria.example"
    assert body["description"] == "Cozy trattoria near the centre."


def test_enrich_place_works_with_no_saved_item_yet(client, session, stop, monkeypatch):
    """The whole point: no item needs to exist for this stop for enrich to work."""
    monkeypatch.setattr(items_mod, "_PLACES_KEY", "fake-key")
    fake = FakeClient()
    monkeypatch.setattr(items_mod.httpx, "Client", lambda *a, **k: fake)

    assert client.get(f"/stops/{stop['id']}/items").json() == []
    r = client.get(f"/stops/{stop['id']}/enrich", params={"kind": "activity", "name": "Colosseum"})
    assert r.status_code == 200
    assert fake.captured_input == "Colosseum"
