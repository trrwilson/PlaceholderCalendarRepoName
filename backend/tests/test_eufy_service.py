"""EufyEventService policy tests — a scripted fake bridge client, no network,
no real Node process. Mirrors the fake-client style used for the voice relay
and wake providers."""

from __future__ import annotations

import asyncio
import base64

import pytest

from app.config import Settings
from app.eufy.service import EufyEventService
from app.models import ApplicationMessage

CLIP1 = {
    "type": "clip_discovered",
    "clip_id": "a:1",
    "camera_id": "a",
    "camera_name": "Front Door",
    "occurred_at": "2026-09-07T18:30:00Z",
}


class FakeBridgeClient:
    """A scripted bridge connection: `send()` records what was sent, `push()`
    (test-only) makes a message appear from `messages()`, `close()` ends the
    iteration cleanly (mirrors a real dropped socket)."""

    def __init__(self) -> None:
        self.connected = False
        self.closed = False
        self.sent: list[dict] = []
        self._queue: asyncio.Queue[dict | None] = asyncio.Queue()

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.closed = True
        await self._queue.put(None)

    async def send(self, message: dict) -> None:
        self.sent.append(message)

    async def messages(self):
        while True:
            item = await self._queue.get()
            if item is None:
                return
            yield item

    def push(self, message: dict) -> None:
        self._queue.put_nowait(message)


def make_service(**settings_overrides):
    broadcasts: list[ApplicationMessage] = []

    async def broadcast(message: ApplicationMessage) -> None:
        broadcasts.append(message)

    client = FakeBridgeClient()
    settings_overrides.setdefault("eufy_enabled", True)
    settings_overrides.setdefault("eufy_bridge_restart_backoff_seconds", 0.01)
    settings_overrides.setdefault("eufy_bridge_restart_backoff_max_seconds", 0.02)
    settings = Settings(_env_file=None, **settings_overrides)
    service = EufyEventService(
        settings=settings, broadcast=broadcast, client_factory=lambda: client
    )
    return service, client, broadcasts


async def _wait_until(predicate, timeout: float = 2.0) -> None:
    async def _poll():
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(_poll(), timeout)


async def _stop(service: EufyEventService, task: asyncio.Task) -> None:
    await service.stop()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_run_is_a_noop_when_disabled():
    service, client, broadcasts = make_service(eufy_enabled=False)
    await service.run()
    assert client.connected is False
    assert broadcasts == []


async def test_clip_discovered_appends_and_broadcasts():
    service, client, broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push(CLIP1)
        await _wait_until(lambda: len(service.snapshot().clips) == 1)
        assert service.snapshot().clips[0].clip_id == "a:1"
        assert broadcasts[-1].camera_clips[0].clip_id == "a:1"
        assert broadcasts[-1].type == "camera_clips"
    finally:
        await _stop(service, task)


async def test_ring_buffer_bounded_and_newest_first():
    service, client, broadcasts = make_service(eufy_clip_ring_buffer_size=2)
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        for i in range(3):
            client.push({**CLIP1, "clip_id": f"a:{i}"})
        await _wait_until(lambda: len(service.snapshot().clips) == 2)
        ids = [c.clip_id for c in service.snapshot().clips]
        assert ids == ["a:2", "a:1"]
    finally:
        await _stop(service, task)


async def test_duplicate_clip_id_ignored_and_not_rebroadcast():
    service, client, broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push(CLIP1)
        await _wait_until(lambda: len(service.snapshot().clips) == 1)
        broadcasts.clear()
        client.push(CLIP1)
        await asyncio.sleep(0.05)
        assert len(service.snapshot().clips) == 1
        assert broadcasts == []
    finally:
        await _stop(service, task)


async def test_status_transitions_broadcast_only_on_change():
    service, client, broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: service.status() == "connecting")
        broadcasts.clear()
        client.push({"type": "status", "state": "connected"})
        await _wait_until(lambda: service.status() == "connected")
        assert len(broadcasts) == 1
        client.push({"type": "status", "state": "connected"})
        await asyncio.sleep(0.05)
        assert len(broadcasts) == 1
    finally:
        await _stop(service, task)


async def test_ready_message_sets_cameras_online():
    service, client, broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push({"type": "ready", "devices": [{"camera_id": "a", "camera_name": "Front Door"}]})
        await _wait_until(lambda: service.snapshot().cameras_online is True)
    finally:
        await _stop(service, task)


async def test_get_thumbnail_round_trip_then_cached():
    service, client, broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push(CLIP1)
        await _wait_until(lambda: service.has_clip("a:1"))

        payload = base64.b64encode(b"fake-jpeg-bytes").decode()

        async def answer():
            await _wait_until(lambda: any(m["type"] == "get_thumbnail" for m in client.sent))
            request = next(m for m in client.sent if m["type"] == "get_thumbnail")
            client.push(
                {"type": "thumbnail", "request_id": request["request_id"], "data_base64": payload}
            )

        answerer = asyncio.create_task(answer())
        data = await service.get_thumbnail("a:1")
        await answerer
        assert data == b"fake-jpeg-bytes"

        sent_before = len(client.sent)
        data2 = await service.get_thumbnail("a:1")
        assert data2 == b"fake-jpeg-bytes"
        assert len(client.sent) == sent_before  # cache hit, no second request
    finally:
        await _stop(service, task)


async def test_get_thumbnail_unknown_clip_is_none():
    service, _client, _broadcasts = make_service()
    assert await service.get_thumbnail("does-not-exist") is None


async def test_get_video_path_error_response_is_none():
    service, client, _broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push(CLIP1)
        await _wait_until(lambda: service.has_clip("a:1"))

        async def answer():
            await _wait_until(lambda: any(m["type"] == "retrieve_clip" for m in client.sent))
            request = next(m for m in client.sent if m["type"] == "retrieve_clip")
            client.push(
                {
                    "type": "clip_file",
                    "request_id": request["request_id"],
                    "error": "download failed",
                }
            )

        answerer = asyncio.create_task(answer())
        path = await service.get_video_path("a:1")
        await answerer
        assert path is None
    finally:
        await _stop(service, task)


async def test_get_video_path_success_returns_existing_file(tmp_path):
    service, client, _broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push(CLIP1)
        await _wait_until(lambda: service.has_clip("a:1"))

        clip_file = tmp_path / "clip.mp4"
        clip_file.write_bytes(b"not-really-an-mp4")

        async def answer():
            await _wait_until(lambda: any(m["type"] == "retrieve_clip" for m in client.sent))
            request = next(m for m in client.sent if m["type"] == "retrieve_clip")
            client.push(
                {"type": "clip_file", "request_id": request["request_id"], "path": str(clip_file)}
            )

        answerer = asyncio.create_task(answer())
        path = await service.get_video_path("a:1")
        await answerer
        assert path == clip_file
    finally:
        await _stop(service, task)


async def test_get_video_path_missing_file_on_disk_is_none():
    service, client, _broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push(CLIP1)
        await _wait_until(lambda: service.has_clip("a:1"))

        async def answer():
            await _wait_until(lambda: any(m["type"] == "retrieve_clip" for m in client.sent))
            request = next(m for m in client.sent if m["type"] == "retrieve_clip")
            client.push(
                {
                    "type": "clip_file",
                    "request_id": request["request_id"],
                    "path": "/no/such/file.mp4",
                }
            )

        answerer = asyncio.create_task(answer())
        path = await service.get_video_path("a:1")
        await answerer
        assert path is None
    finally:
        await _stop(service, task)


async def test_pending_request_fails_on_disconnect():
    service, client, _broadcasts = make_service()
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: client.connected)
        client.push(CLIP1)
        await _wait_until(lambda: service.has_clip("a:1"))

        disconnect = asyncio.create_task(client.close())
        del disconnect  # fire-and-forget; completes well before the request timeout
        result = await service.get_thumbnail("a:1")
        assert result is None
    finally:
        await _stop(service, task)


async def test_start_and_stop_bridge_are_invoked():
    starts = 0
    stops = 0

    async def start_bridge():
        nonlocal starts
        starts += 1

    async def stop_bridge():
        nonlocal stops
        stops += 1

    broadcasts: list[ApplicationMessage] = []

    async def broadcast(message: ApplicationMessage) -> None:
        broadcasts.append(message)

    client = FakeBridgeClient()
    settings = Settings(
        _env_file=None,
        eufy_enabled=True,
        eufy_bridge_restart_backoff_seconds=0.01,
        eufy_bridge_restart_backoff_max_seconds=0.02,
    )
    service = EufyEventService(
        settings=settings,
        broadcast=broadcast,
        client_factory=lambda: client,
        start_bridge=start_bridge,
        stop_bridge=stop_bridge,
    )
    task = asyncio.create_task(service.run())
    try:
        await _wait_until(lambda: starts >= 1)
    finally:
        await service.stop()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert stops == 1
