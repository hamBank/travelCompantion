"""Packing list: visibility (mine + shared), counts, CRUD, ownership, bags."""
from backend.models import PackingItem, Bag

ME = "dev@local"   # get_current_user returns this when auth is disabled


def _trip(client) -> int:
    return client.post("/trips/", json={"name": "Packing trip"}).json()["id"]


def _seed(session, trip_id, **kw):
    item = PackingItem(trip_id=trip_id, name=kw.get("name", "x"),
                       owner_email=kw.get("owner_email", ME),
                       quantity=kw.get("quantity", 1),
                       packed_count=kw.get("packed_count", 0),
                       bag_id=kw.get("bag_id"))
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def test_visibility_returns_own_and_shared_not_others(client, session):
    tid = _trip(client)
    _seed(session, tid, name="my socks", owner_email=ME)
    _seed(session, tid, name="shared tent", owner_email="")
    _seed(session, tid, name="her dress", owner_email="someone@else.com")

    body = client.get(f"/trips/{tid}/packing").json()
    names = {i["name"] for i in body["items"]}
    assert names == {"my socks", "shared tent"}


def test_counts_sum_quantity_and_packed(client, session):
    tid = _trip(client)
    _seed(session, tid, name="socks", quantity=5, packed_count=3, owner_email=ME)
    _seed(session, tid, name="tent", quantity=1, packed_count=1, owner_email="")
    _seed(session, tid, name="hers", quantity=9, packed_count=9, owner_email="x@y.com")  # excluded

    counts = client.get(f"/trips/{tid}/packing").json()["counts"]
    assert counts == {"total": 6, "packed": 4}   # 5+1 total, 3+1 packed (hers excluded)


def test_create_personal_and_shared_items(client):
    tid = _trip(client)
    r1 = client.post(f"/trips/{tid}/packing", json={"name": "toothbrush"})
    assert r1.json()["owner_email"] == ME            # personal by default

    r2 = client.post(f"/trips/{tid}/packing", json={"name": "first aid", "shared": True})
    assert r2.json()["owner_email"] == ""            # shared


def test_packed_count_clamped_to_quantity(client):
    tid = _trip(client)
    item = client.post(f"/trips/{tid}/packing", json={"name": "socks", "quantity": 3}).json()
    r = client.patch(f"/packing/{item['id']}", json={"packed_count": 99})
    assert r.json()["packed_count"] == 3             # clamped to quantity
    r2 = client.patch(f"/packing/{item['id']}", json={"packed_count": -5})
    assert r2.json()["packed_count"] == 0


def test_cannot_edit_or_delete_another_users_personal_item(client, session):
    tid = _trip(client)
    other = _seed(session, tid, name="hers", owner_email="someone@else.com")
    assert client.patch(f"/packing/{other.id}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/packing/{other.id}").status_code == 404


def test_nested_bags_and_cycle_protection(client):
    tid = _trip(client)
    outer = client.post(f"/trips/{tid}/bags", json={"name": "Suitcase"}).json()
    inner = client.post(f"/trips/{tid}/bags", json={"name": "Cube", "parent_id": outer["id"]}).json()
    assert inner["parent_id"] == outer["id"]

    # A bag can't be its own parent
    assert client.patch(f"/bags/{outer['id']}", json={"parent_id": outer["id"]}).status_code == 400
    # Can't nest a bag inside its own descendant (would create a cycle)
    assert client.patch(f"/bags/{outer['id']}", json={"parent_id": inner["id"]}).status_code == 400

    # Clearing the parent is allowed
    assert client.patch(f"/bags/{inner['id']}", json={"parent_id": None}).json()["parent_id"] is None


def test_deleting_parent_promotes_children(client):
    tid = _trip(client)
    outer = client.post(f"/trips/{tid}/bags", json={"name": "Suitcase"}).json()
    inner = client.post(f"/trips/{tid}/bags", json={"name": "Cube", "parent_id": outer["id"]}).json()

    assert client.delete(f"/bags/{outer['id']}").status_code == 204
    bags = {b["id"]: b for b in client.get(f"/trips/{tid}/packing").json()["bags"]}
    assert outer["id"] not in bags
    assert bags[inner["id"]]["parent_id"] is None   # promoted to top level


def test_bag_crud_and_unassign_on_delete(client, session):
    tid = _trip(client)
    bag = client.post(f"/trips/{tid}/bags", json={"name": "Carry-on"}).json()
    item = client.post(f"/trips/{tid}/packing", json={"name": "charger", "bag_id": bag["id"]}).json()
    assert item["bag_id"] == bag["id"]

    # rename
    assert client.patch(f"/bags/{bag['id']}", json={"name": "Backpack"}).json()["name"] == "Backpack"

    # delete bag → item is unassigned, not deleted
    assert client.delete(f"/bags/{bag['id']}").status_code == 204
    refreshed = client.get(f"/trips/{tid}/packing").json()
    assert refreshed["bags"] == []
    charger = next(i for i in refreshed["items"] if i["name"] == "charger")
    assert charger["bag_id"] is None
