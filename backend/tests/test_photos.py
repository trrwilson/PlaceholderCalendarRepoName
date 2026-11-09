"""Photo stream: OneDrive delta source (mocked Graph via respx), the capped disk
cache, the sync service, and the LAN / privacy gates on /api/photos. No live
Graph calls (AGENTS.md) — `scripts/verify_photo_source.py` covers the real account.
"""

from __future__ import annotations

import asyncio
from datetime import datetime

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

import app.api as api
from app.config import get_settings
from app.main import app
from app.models import PhotoItem
from app.photos.cache import PhotoCache
from app.photos.onedrive import GRAPH, NeedsSignIn, OneDriveFolderSource, Throttled, to_photo
from app.photos.service import PhotoStreamService

FOLDER = "FOLDER!1"
DELTA = f"{GRAPH}/me/drive/items/{FOLDER}/delta"


def _photo(item_id: str, ctag: str = "c1", taken: str | None = "2026-07-04T18:00:00Z") -> dict:
    raw = {
        "id": item_id,
        "name": f"{item_id}.jpg",
        "cTag": ctag,
        "file": {"mimeType": "image/jpeg"},
        "image": {"width": 4032, "height": 3024},
        "parentReference": {"id": FOLDER},
    }
    if taken:
        raw["photo"] = {"takenDateTime": taken}
    return raw


def _source(client: httpx.Client) -> OneDriveFolderSource:
    return OneDriveFolderSource(
        token_provider=lambda: "token",
        folder_path="Pictures/Mission Control",
        rendition="c2560x1440",
        client=client,
    )


def _thumb(item_id: str) -> str:
    return f"{GRAPH}/me/drive/items/{item_id}/thumbnails/0/c2560x1440/content"


# -- source --------------------------------------------------------------------


def test_to_photo_skips_folders_and_videos() -> None:
    assert to_photo({"id": "f", "name": "sub", "folder": {}}) is None
    assert to_photo({"id": "v", "name": "v.mp4", "file": {"mimeType": "video/mp4"}}) is None
    item = to_photo(_photo("a"))
    assert item is not None and item.width == 4032 and item.version == "c1"
    assert item.taken_at is not None and item.taken_at.tzinfo is None  # naive local


@respx.mock
def test_initial_delta_pages_and_returns_delta_link() -> None:
    respx.get(DELTA).mock(
        return_value=httpx.Response(
            200,
            json={
                "value": [{"id": FOLDER, "folder": {}}, _photo("a")],
                "@odata.nextLink": f"{GRAPH}/page2",
            },
        )
    )
    respx.get(f"{GRAPH}/page2").mock(
        return_value=httpx.Response(
            200,
            json={
                "value": [_photo("b"), {"id": "x", "deleted": {}}],
                "@odata.deltaLink": f"{GRAPH}/delta-next",
            },
        )
    )
    with httpx.Client() as client:
        result = _source(client).changes(FOLDER, None)
    assert result.full is True
    assert [p.id for p in result.upserts] == ["a", "b"]
    assert result.deleted == {"x"}
    assert result.delta_link == f"{GRAPH}/delta-next"


@respx.mock
def test_410_restarts_as_full_enumeration() -> None:
    respx.get(f"{GRAPH}/stale").mock(
        return_value=httpx.Response(
            410,
            headers={"Location": f"{GRAPH}/fresh"},
            json={"error": {"code": "resyncRequired"}},
        )
    )
    respx.get(f"{GRAPH}/fresh").mock(
        return_value=httpx.Response(
            200, json={"value": [_photo("a")], "@odata.deltaLink": f"{GRAPH}/d2"}
        )
    )
    with httpx.Client() as client:
        result = _source(client).changes(FOLDER, f"{GRAPH}/stale")
    assert result.full is True and [p.id for p in result.upserts] == ["a"]


@respx.mock
def test_throttle_and_auth_errors_are_typed() -> None:
    respx.get(f"{GRAPH}/t").mock(return_value=httpx.Response(429, headers={"Retry-After": "7"}))
    respx.get(f"{GRAPH}/u").mock(return_value=httpx.Response(401))
    with httpx.Client() as client:
        with pytest.raises(Throttled) as throttled:
            _source(client).changes(FOLDER, f"{GRAPH}/t")
        assert throttled.value.retry_after == 7
        with pytest.raises(NeedsSignIn):
            _source(client).changes(FOLDER, f"{GRAPH}/u")


# -- cache ---------------------------------------------------------------------


def _item(item_id: str, version: str = "v1", taken: datetime | None = None) -> PhotoItem:
    return PhotoItem(id=item_id, name=f"{item_id}.jpg", version=version, taken_at=taken)


def test_cache_caps_and_survives_reload(tmp_path) -> None:
    cache = PhotoCache(tmp_path, max_items=2, max_bytes=10)
    assert cache.put(_item("a"), b"1234")
    assert cache.put(_item("b"), b"1234")
    assert not cache.put(_item("c"), b"1")  # item cap
    assert cache.put(_item("a", "v2"), b"123456")  # replacing doesn't count itself
    assert not cache.put(_item("b", "v2"), b"12345")  # byte cap
    (tmp_path / "orphan.jpg").write_bytes(b"x")

    reloaded = PhotoCache(tmp_path, max_items=2, max_bytes=10)
    reloaded.load()
    assert {p.id: p.version for p in reloaded.photos()} == {"a": "v2", "b": "v1"}
    assert not (tmp_path / "orphan.jpg").exists()
    assert reloaded.path_for("a").read_bytes() == b"123456"


def test_cache_corrupt_manifest_starts_empty(tmp_path) -> None:
    (tmp_path / "manifest.json").write_text("{not json")
    cache = PhotoCache(tmp_path, max_items=5, max_bytes=100)
    cache.load()
    assert cache.photos() == []


# -- service -------------------------------------------------------------------


class FakeSource:
    def __init__(self) -> None:
        self.rounds: list = []
        self.fail_fetch: set[str] = set()
        self.fetched: list[str] = []
        self.links_seen: list[str | None] = []

    def resolve_folder(self) -> str:
        return FOLDER

    def changes(self, folder_id: str, delta_link: str | None):
        self.links_seen.append(delta_link)
        return self.rounds.pop(0)

    def fetch(self, photo_id: str) -> bytes:
        from app.photos.onedrive import PhotoSourceError

        self.fetched.append(photo_id)
        if photo_id in self.fail_fetch:
            raise PhotoSourceError("boom")
        return b"jpeg-" + photo_id.encode()


def _service(tmp_path, source: FakeSource, **kw) -> PhotoStreamService:
    cache = PhotoCache(tmp_path, max_items=kw.pop("max_items", 50), max_bytes=10_000)
    return PhotoStreamService(source=source, cache=cache, source_key="k", interval_seconds=60, **kw)


def test_service_full_then_incremental(tmp_path) -> None:
    from app.photos.onedrive import DeltaResult

    source = FakeSource()
    source.rounds = [
        DeltaResult(upserts=[_item("a"), _item("b")], delta_link="L1", full=True),
        DeltaResult(upserts=[_item("a", "v2")], deleted={"b"}, delta_link="L2"),
        DeltaResult(delta_link="L3"),
    ]
    service = _service(tmp_path, source)
    assert service.sync_once() is True
    assert service.sync_once() is True
    assert {p.id: p.version for p in service.snapshot().photos} == {"a": "v2"}
    assert service.sync_once() is False
    assert source.links_seen == [None, "L1", "L2"]
    assert source.fetched == ["a", "b", "a"]
    assert service.snapshot().status == "ok"


def test_failed_download_does_not_advance_delta_link(tmp_path) -> None:
    from app.photos.onedrive import DeltaResult

    source = FakeSource()
    source.fail_fetch = {"b"}
    source.rounds = [
        DeltaResult(upserts=[_item("a"), _item("b")], delta_link="L1", full=True),
        DeltaResult(upserts=[_item("a"), _item("b")], delta_link="L1b", full=True),
    ]
    service = _service(tmp_path, source)
    service.sync_once()
    source.fail_fetch = set()
    service.sync_once()
    assert source.links_seen == [None, None]  # L1 was never stored
    assert source.fetched == ["a", "b", "b"]  # "a" not re-downloaded
    assert service.cache.load_state()["delta_link"] == "L1b"


def test_full_resync_evicts_unseen_and_cap_keeps_newest(tmp_path) -> None:
    from app.photos.onedrive import DeltaResult

    source = FakeSource()
    old, new = datetime(2020, 1, 1), datetime(2026, 1, 1)
    source.rounds = [
        DeltaResult(
            upserts=[_item("old", taken=old), _item("new", taken=new)], delta_link="L", full=True
        ),
        DeltaResult(upserts=[_item("other")], delta_link="L2", full=True),
    ]
    service = _service(tmp_path, source, max_items=1)
    service.sync_once()
    assert [p.id for p in service.snapshot().photos] == ["new"]
    service.sync_once()
    assert [p.id for p in service.snapshot().photos] == ["other"]


def test_sign_in_failure_is_status_not_exception(tmp_path) -> None:
    class NoAuth(FakeSource):
        def resolve_folder(self) -> str:
            raise NeedsSignIn("nope")

    service = _service(tmp_path, NoAuth())
    assert service.sync_once() is False
    assert service.snapshot().status == "needs_sign_in"


def test_run_broadcasts_after_change(tmp_path) -> None:
    from app.photos.onedrive import DeltaResult

    sent = []

    async def broadcast(message) -> None:
        sent.append(message)
        await service.stop()

    source = FakeSource()
    source.rounds = [DeltaResult(upserts=[_item("a")], delta_link="L", full=True)]
    service = _service(tmp_path, source, broadcast=broadcast)
    asyncio.run(asyncio.wait_for(service.run(), timeout=5))
    assert sent and sent[0].type == "photos" and sent[0].photos.photos[0].id == "a"


# -- API -----------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    yield TestClient(app)
    get_settings.cache_clear()


def test_api_disabled(client: TestClient) -> None:
    body = client.get("/api/photos").json()
    assert body["enabled"] is False and body["status"] == "disabled"
    assert client.get("/api/photos/a").status_code == 409


def test_api_enabled_serves_cache_and_gates_sync(
    client: TestClient, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = _service(tmp_path, FakeSource())
    service.cache.put(_item("a"), b"jpeg-a")
    monkeypatch.setattr(api, "get_photo_service", lambda: service)

    body = client.get("/api/photos").json()
    assert body["enabled"] is True and body["photos"][0]["id"] == "a"
    image = client.get("/api/photos/a")
    assert image.status_code == 200 and image.content == b"jpeg-a"
    assert client.get("/api/photos/missing").status_code == 404
    assert client.post("/api/photos/sync").status_code == 202

    monkeypatch.setattr(api, "_require_unlocked", _locked)
    assert client.post("/api/photos/sync").status_code == 423


def _locked() -> None:
    from fastapi import HTTPException

    raise HTTPException(status_code=423, detail="locked")


def test_api_rejects_remote_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "false")
    get_settings.cache_clear()
    remote = TestClient(app, client=("8.8.8.8", 1234))
    assert remote.get("/api/photos").status_code == 403
    get_settings.cache_clear()


def test_sign_in_requests_files_read_only_when_photos_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.calendar.personal_auth import sign_in_scopes

    get_settings.cache_clear()
    assert "Files.Read" not in sign_in_scopes(get_settings())
    monkeypatch.setenv("MISSION_CONTROL_PHOTOS_ENABLED", "true")
    get_settings.cache_clear()
    assert sign_in_scopes(get_settings()) == ["Calendars.Read", "Files.Read"]
    get_settings.cache_clear()
