"""API-level tests for the eufy clip gallery endpoints (`GET /api/household`,
`GET /api/camera/clip/{id}/thumbnail`, `GET /api/camera/clip/{id}/video`).

`eufy_enabled` defaults False, so the disabled-path tests need nothing special.
For the enabled path, `app.api.get_eufy_service` is monkeypatched to a fake —
never spawns a real bridge process or touches Node/the network (AGENTS.md:
"Real ML/ONNX models and live provider endpoints are validated on hardware...
never in CI").
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.api as api
from app.config import get_settings
from app.main import app
from app.models import CameraGallerySnapshot, StoredClip


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # `_require_local` sees the TestClient's synthetic host as non-local
    # otherwise — same fixture shape as tests/test_presence.py.
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    return TestClient(app)


class FakeEufyService:
    def __init__(
        self,
        snapshot: CameraGallerySnapshot,
        *,
        thumbnails: dict[str, bytes] | None = None,
        video_paths: dict[str, object] | None = None,
    ) -> None:
        self._snapshot = snapshot
        self._known = {clip.clip_id for clip in snapshot.clips}
        self._thumbnails = thumbnails or {}
        self._video_paths = video_paths or {}

    def snapshot(self) -> CameraGallerySnapshot:
        return self._snapshot

    def has_clip(self, clip_id: str) -> bool:
        return clip_id in self._known

    async def get_thumbnail(self, clip_id: str) -> bytes | None:
        return self._thumbnails.get(clip_id)

    async def get_video_path(self, clip_id: str):
        return self._video_paths.get(clip_id)


CLIP = StoredClip(
    clip_id="a:1",
    camera_id="a",
    camera_name="Front Door",
    occurred_at="2026-09-07T18:30:00",
    approx_duration_seconds=20.0,
)


def test_household_409_when_disabled(client: TestClient) -> None:
    response = client.get("/api/household")
    assert response.status_code == 409


def test_household_returns_snapshot_when_enabled(client: TestClient, monkeypatch) -> None:
    snapshot = CameraGallerySnapshot(clips=[CLIP], source_status="connected", cameras_online=True)
    monkeypatch.setattr(api, "get_eufy_service", lambda: FakeEufyService(snapshot))
    response = client.get("/api/household")
    assert response.status_code == 200
    body = response.json()
    assert body["source_status"] == "connected"
    assert body["cameras_online"] is True
    assert body["clips"][0]["clip_id"] == "a:1"


def test_thumbnail_409_when_disabled(client: TestClient) -> None:
    assert client.get("/api/camera/clip/a:1/thumbnail").status_code == 409


def test_thumbnail_404_for_unknown_clip(client: TestClient, monkeypatch) -> None:
    snapshot = CameraGallerySnapshot(clips=[], source_status="connected", cameras_online=True)
    monkeypatch.setattr(api, "get_eufy_service", lambda: FakeEufyService(snapshot))
    response = client.get("/api/camera/clip/does-not-exist/thumbnail")
    assert response.status_code == 404


def test_thumbnail_503_when_bridge_cannot_resolve_it(client: TestClient, monkeypatch) -> None:
    snapshot = CameraGallerySnapshot(clips=[CLIP], source_status="connected", cameras_online=True)
    monkeypatch.setattr(api, "get_eufy_service", lambda: FakeEufyService(snapshot))
    response = client.get("/api/camera/clip/a:1/thumbnail")
    assert response.status_code == 503


def test_thumbnail_200_returns_jpeg_bytes(client: TestClient, monkeypatch) -> None:
    snapshot = CameraGallerySnapshot(clips=[CLIP], source_status="connected", cameras_online=True)
    service = FakeEufyService(snapshot, thumbnails={"a:1": b"fake-jpeg-bytes"})
    monkeypatch.setattr(api, "get_eufy_service", lambda: service)
    response = client.get("/api/camera/clip/a:1/thumbnail")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content == b"fake-jpeg-bytes"


def test_video_409_when_disabled(client: TestClient) -> None:
    assert client.get("/api/camera/clip/a:1/video").status_code == 409


def test_video_404_for_unknown_clip(client: TestClient, monkeypatch) -> None:
    snapshot = CameraGallerySnapshot(clips=[], source_status="connected", cameras_online=True)
    monkeypatch.setattr(api, "get_eufy_service", lambda: FakeEufyService(snapshot))
    assert client.get("/api/camera/clip/does-not-exist/video").status_code == 404


def test_video_503_when_bridge_cannot_retrieve_it(client: TestClient, monkeypatch) -> None:
    snapshot = CameraGallerySnapshot(clips=[CLIP], source_status="connected", cameras_online=True)
    monkeypatch.setattr(api, "get_eufy_service", lambda: FakeEufyService(snapshot))
    response = client.get("/api/camera/clip/a:1/video")
    assert response.status_code == 503


def test_video_200_streams_the_cached_file(client: TestClient, monkeypatch, tmp_path) -> None:
    clip_file = tmp_path / "clip.mp4"
    clip_file.write_bytes(b"not-really-an-mp4")
    snapshot = CameraGallerySnapshot(clips=[CLIP], source_status="connected", cameras_online=True)
    service = FakeEufyService(snapshot, video_paths={"a:1": clip_file})
    monkeypatch.setattr(api, "get_eufy_service", lambda: service)
    response = client.get("/api/camera/clip/a:1/video")
    assert response.status_code == 200
    assert response.headers["content-type"] == "video/mp4"
    assert response.content == b"not-really-an-mp4"
