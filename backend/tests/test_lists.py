from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.lists import ListStore
from app.main import app
from app.models import (
    GROCERY_LIST_ID,
    ApplicationMessage,
    ListClearScope,
    ListItem,
    ListItemSource,
    ListItemUpdateRequest,
)

BASE = datetime(2026, 9, 7, 9, 0, 0)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    from app.config import get_settings

    get_settings.cache_clear()
    return TestClient(app)


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def make_store(clock: FakeClock, **kw) -> tuple[ListStore, list[ApplicationMessage]]:
    sent: list[ApplicationMessage] = []

    async def broadcast(message: ApplicationMessage) -> None:
        sent.append(message)

    return ListStore(clock=clock, broadcast=broadcast, **kw), sent


# -- model -------------------------------------------------------------------


def test_list_item_rejects_checked_without_timestamp() -> None:
    with pytest.raises(ValidationError):
        ListItem(id="x", name="milk", added_at=BASE, checked=True)


def test_list_item_rejects_a_blank_name() -> None:
    with pytest.raises(ValidationError):
        ListItem(id="x", name="   ".strip(), added_at=BASE)


# -- store -------------------------------------------------------------------


async def test_seeds_one_empty_grocery_list() -> None:
    store, _ = make_store(FakeClock(BASE))
    lists = store.list_all()
    assert [gl.id for gl in lists] == [GROCERY_LIST_ID]
    assert lists[0].items == []


async def test_add_prepends_and_broadcasts() -> None:
    store, sent = make_store(FakeClock(BASE))
    result = await store.add_items(GROCERY_LIST_ID, ["milk", "eggs"], source=ListItemSource.voice)
    assert result.added == ["milk", "eggs"]
    assert [i.name for i in result.list.items] == ["eggs", "milk"]  # newest first
    assert sent[-1].type == "list-item-added"
    assert sent[-1].list.items[0].name == "eggs"


async def test_add_dedupes_an_unchecked_match() -> None:
    store, _ = make_store(FakeClock(BASE))
    await store.add_items(GROCERY_LIST_ID, ["milk"])
    result = await store.add_items(GROCERY_LIST_ID, ["  MILK "])
    assert result.added == []
    assert result.already_present == ["milk"]
    assert len(result.list.items) == 1


async def test_add_puts_a_checked_item_back_on() -> None:
    clock = FakeClock(BASE)
    store, _ = make_store(clock)
    added = await store.add_items(GROCERY_LIST_ID, ["milk"])
    item_id = added.list.items[0].id
    await store.update_item(GROCERY_LIST_ID, item_id, ListItemUpdateRequest(checked=True))

    clock.advance(60)
    result = await store.add_items(GROCERY_LIST_ID, ["milk"])
    assert result.added == ["milk"]
    assert result.list.items[0].checked is False
    assert result.list.items[0].id == item_id


async def test_check_and_uncheck_set_the_timestamp() -> None:
    store, sent = make_store(FakeClock(BASE))
    added = await store.add_items(GROCERY_LIST_ID, ["milk"])
    item_id = added.list.items[0].id

    checked = await store.update_item(GROCERY_LIST_ID, item_id, ListItemUpdateRequest(checked=True))
    assert checked.list.items[0].checked_at == BASE
    assert sent[-1].type == "list-item-checked"

    unchecked = await store.update_item(
        GROCERY_LIST_ID, item_id, ListItemUpdateRequest(checked=False)
    )
    assert unchecked.list.items[0].checked_at is None
    assert sent[-1].type == "list-item-unchecked"


async def test_remove_returns_the_item_for_undo() -> None:
    store, sent = make_store(FakeClock(BASE))
    added = await store.add_items(GROCERY_LIST_ID, ["milk", "eggs"])
    victim = added.list.items[0].id
    result = await store.remove_item(GROCERY_LIST_ID, victim)
    assert [i.id for i in result.removed] == [victim]
    assert len(result.list.items) == 1
    assert sent[-1].type == "list-item-removed"


async def test_clear_checked_vs_all() -> None:
    store, _ = make_store(FakeClock(BASE))
    added = await store.add_items(GROCERY_LIST_ID, ["milk", "eggs", "bread"])
    await store.update_item(
        GROCERY_LIST_ID, added.list.items[0].id, ListItemUpdateRequest(checked=True)
    )

    checked_clear = await store.clear(GROCERY_LIST_ID, ListClearScope.checked)
    assert len(checked_clear.removed) == 1
    assert len(checked_clear.list.items) == 2

    all_clear = await store.clear(GROCERY_LIST_ID, ListClearScope.all)
    assert len(all_clear.removed) == 2
    assert all_clear.list.items == []


async def test_restore_round_trips_a_cleared_list() -> None:
    store, _ = make_store(FakeClock(BASE))
    await store.add_items(GROCERY_LIST_ID, ["milk", "eggs"])
    cleared = await store.clear(GROCERY_LIST_ID, ListClearScope.all)
    assert cleared.list.items == []

    restored = await store.restore(GROCERY_LIST_ID, cleared.removed)
    assert sorted(i.name for i in restored.list.items) == ["eggs", "milk"]


async def test_reorder_applies_a_custom_order_and_broadcasts() -> None:
    store, sent = make_store(FakeClock(BASE))
    added = await store.add_items(GROCERY_LIST_ID, ["milk", "eggs", "bread"])
    # newest-first: bread, eggs, milk
    ids = {i.name: i.id for i in added.list.items}

    result = await store.reorder(GROCERY_LIST_ID, [ids["milk"], ids["bread"], ids["eggs"]])
    assert [i.name for i in result.list.items] == ["milk", "bread", "eggs"]
    assert sent[-1].type == "list-reordered"
    assert [i.name for i in sent[-1].list.items] == ["milk", "bread", "eggs"]


async def test_reorder_with_a_partial_id_list_keeps_the_rest_after() -> None:
    store, _ = make_store(FakeClock(BASE))
    added = await store.add_items(GROCERY_LIST_ID, ["milk", "eggs", "bread"])
    ids = {i.name: i.id for i in added.list.items}
    # Only name two; the third keeps its place, after the named ones.
    result = await store.reorder(GROCERY_LIST_ID, [ids["eggs"], ids["milk"]])
    assert [i.name for i in result.list.items] == ["eggs", "milk", "bread"]


async def test_reorder_is_a_no_op_when_the_order_is_unchanged() -> None:
    store, sent = make_store(FakeClock(BASE))
    added = await store.add_items(GROCERY_LIST_ID, ["milk", "eggs"])
    before = len(sent)
    same = [i.id for i in added.list.items]
    await store.reorder(GROCERY_LIST_ID, same)
    assert len(sent) == before  # nothing broadcast


async def test_reorder_survives_a_reload_and_undo_keeps_it() -> None:
    store, _ = make_store(FakeClock(BASE))
    added = await store.add_items(GROCERY_LIST_ID, ["milk", "eggs", "bread"])
    ids = {i.name: i.id for i in added.list.items}
    await store.reorder(GROCERY_LIST_ID, [ids["milk"], ids["bread"], ids["eggs"]])

    cleared = await store.clear(GROCERY_LIST_ID, ListClearScope.all)
    restored = await store.restore(GROCERY_LIST_ID, cleared.removed)
    # Undo preserves the custom order (restore no longer re-sorts).
    assert [i.name for i in restored.list.items] == ["milk", "bread", "eggs"]


async def test_recent_names_capped_and_survive_a_clear() -> None:
    store, _ = make_store(FakeClock(BASE), recent_names_max=3)
    for name in ["milk", "eggs", "bread", "butter"]:
        await store.add_items(GROCERY_LIST_ID, [name])
    await store.clear(GROCERY_LIST_ID, ListClearScope.all)
    assert store.get(GROCERY_LIST_ID).recent_names == ["butter", "bread", "eggs"]


async def test_unknown_list_and_item_raise_keyerror() -> None:
    store, _ = make_store(FakeClock(BASE))
    with pytest.raises(KeyError):
        await store.add_items("nope", ["milk"])
    with pytest.raises(KeyError):
        await store.remove_item(GROCERY_LIST_ID, "nope")


# -- persistence -----------------------------------------------------------


async def test_items_reload_from_the_json_file(tmp_path) -> None:
    path = tmp_path / "lists.json"
    store, _ = make_store(FakeClock(BASE), path=path)
    await store.add_items(GROCERY_LIST_ID, ["milk", "eggs"])
    assert path.exists()

    reloaded = ListStore(clock=FakeClock(BASE), path=path)
    assert sorted(i.name for i in reloaded.get(GROCERY_LIST_ID).items) == ["eggs", "milk"]


def test_a_corrupt_file_seeds_fresh(tmp_path) -> None:
    path = tmp_path / "lists.json"
    path.write_text("{ this is not json", encoding="utf-8")
    store = ListStore(clock=FakeClock(BASE), path=path)
    assert store.get(GROCERY_LIST_ID).items == []


# -- endpoints -------------------------------------------------------------


def test_add_check_remove_clear_flow(client: TestClient) -> None:
    added = client.post("/api/lists/grocery/items", json={"names": ["milk", "eggs"]})
    assert added.status_code == 200
    assert added.json()["added"] == ["milk", "eggs"]

    listed = client.get("/api/lists/grocery").json()
    assert {i["name"] for i in listed["items"]} == {"milk", "eggs"}
    milk_id = next(i["id"] for i in listed["items"] if i["name"] == "milk")
    eggs_id = next(i["id"] for i in listed["items"] if i["name"] == "eggs")

    checked = client.patch(f"/api/lists/grocery/items/{milk_id}", json={"checked": True})
    assert any(i["checked"] for i in checked.json()["list"]["items"])

    cleared = client.post("/api/lists/grocery/clear", json={"scope": "checked"})
    assert len(cleared.json()["removed"]) == 1

    assert client.delete(f"/api/lists/grocery/items/{milk_id}").status_code == 404  # gone via clear
    assert client.delete(f"/api/lists/grocery/items/{eggs_id}").status_code == 200


def test_add_requires_a_name(client: TestClient) -> None:
    assert client.post("/api/lists/grocery/items", json={"names": ["  "]}).status_code == 422
    assert client.post("/api/lists/grocery/items", json={}).status_code == 422


def test_unknown_list_is_404(client: TestClient) -> None:
    assert client.get("/api/lists/pantry").status_code == 404
    assert client.post("/api/lists/pantry/items", json={"name": "milk"}).status_code == 404


def test_clear_then_restore_endpoint(client: TestClient) -> None:
    client.post("/api/lists/grocery/items", json={"names": ["milk", "eggs"]})
    cleared = client.post("/api/lists/grocery/clear", json={"scope": "all"}).json()
    assert cleared["list"]["items"] == []
    restored = client.post("/api/lists/grocery/restore", json={"items": cleared["removed"]})
    assert restored.status_code == 200
    assert len(restored.json()["list"]["items"]) == 2


def test_reorder_endpoint(client: TestClient) -> None:
    client.post("/api/lists/grocery/items", json={"names": ["milk", "eggs", "bread"]})
    items = client.get("/api/lists/grocery").json()["items"]  # bread, eggs, milk
    ids = {i["name"]: i["id"] for i in items}

    reordered = client.post(
        "/api/lists/grocery/reorder",
        json={"item_ids": [ids["milk"], ids["bread"], ids["eggs"]]},
    )
    assert reordered.status_code == 200
    assert [i["name"] for i in reordered.json()["list"]["items"]] == ["milk", "bread", "eggs"]
    # Persisted: a fresh GET shows the custom order.
    assert [i["name"] for i in client.get("/api/lists/grocery").json()["items"]] == [
        "milk",
        "bread",
        "eggs",
    ]
    assert client.post("/api/lists/pantry/reorder", json={"item_ids": []}).status_code == 404


def test_list_endpoints_are_gated_to_the_local_network() -> None:
    from app.config import get_settings

    get_settings.cache_clear()
    local_only = TestClient(app)
    assert local_only.get("/api/lists").status_code == 403
    assert local_only.post("/api/lists/grocery/items", json={"name": "milk"}).status_code == 403


def test_websocket_sends_current_lists_on_connect(client: TestClient) -> None:
    client.post("/api/lists/grocery/items", json={"name": "milk"})
    with client.websocket_connect("/api/ws") as ws:
        assert ws.receive_json()["type"] == "connected"
        assert ws.receive_json()["type"] == "timers"
        lists_message = ws.receive_json()
        assert lists_message["type"] == "lists"
        assert lists_message["lists"][0]["items"][0]["name"] == "milk"


def test_websocket_receives_a_broadcast_on_add(client: TestClient) -> None:
    with client.websocket_connect("/api/ws") as ws:
        ws.receive_json()  # connected
        ws.receive_json()  # timers
        ws.receive_json()  # lists
        ws.receive_json()  # privacy
        client.post("/api/lists/grocery/items", json={"name": "bread"})
        pushed = ws.receive_json()
        assert pushed["type"] == "list-item-added"
        assert pushed["list"]["items"][0]["name"] == "bread"
