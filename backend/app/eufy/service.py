"""``EufyEventService`` — the long-lived owner of the eufy clip gallery.

Connects to the bridge (spawning/respawning it via an injected
``EufyBridgeProcess``-shaped pair of callables), maintains the in-memory
gallery state (a bounded newest-first ring buffer of `StoredClip`, a bounded
thumbnail LRU), answers on-demand thumbnail/video requests over the bridge's
request/response control messages, and fans out `ApplicationMessage` pushes on
every change — the same shape `TimerStore` / `GroceryListStore` already use
(injected clock + broadcast, no socket import; see `backend/AGENTS.md`).

Freshness is push-first: the bridge emits `clip_discovered` the moment a real
device event resolves a new local-storage record (verified) or its own
LAN-local reconciliation poll finds one the push missed — this service is a
pure consumer of that stream, not a poller itself. See
docs/eufy-sdk-integration.md.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import uuid
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

from app.config import Settings
from app.eufy.events import parse_clip_discovered, parse_ready, parse_status
from app.models import ApplicationMessage, CameraGallerySnapshot, EufySourceStatus, StoredClip

logger = logging.getLogger(__name__)

# Thumbnail/video are both request/response over the same socket the push
# stream rides on; video is much slower (P2P download + decrypt + an ffmpeg
# mux subprocess), so it gets a longer budget.
THUMBNAIL_REQUEST_TIMEOUT_SECONDS = 15.0
VIDEO_REQUEST_TIMEOUT_SECONDS = 90.0


class EufyBridgeUnavailable(Exception):
    """A thumbnail/video request could not be served because the bridge
    connection is not currently up. The API layer treats this as "not
    available right now" (a 404/503-shaped response), never a 500 — a camera
    hiccup must not look like a backend bug."""


class _BridgeClient(Protocol):
    """The slice of `EufyBridgeClient` this service depends on — narrow enough
    that tests substitute a scripted fake with no real socket."""

    async def connect(self) -> None: ...
    async def close(self) -> None: ...
    async def send(self, message: dict[str, Any]) -> None: ...
    def messages(self) -> AsyncIterator[dict[str, Any]]: ...


class EufyEventService:
    def __init__(
        self,
        *,
        settings: Settings,
        broadcast: Callable[[ApplicationMessage], Awaitable[None]],
        now: Callable[[], datetime] = datetime.now,
        client_factory: Callable[[], _BridgeClient] | None = None,
        start_bridge: Callable[[], Awaitable[None]] | None = None,
        stop_bridge: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._settings = settings
        self._broadcast = broadcast
        self._now = now
        self._client_factory = client_factory or self._default_client_factory
        self._start_bridge = start_bridge
        self._stop_bridge = stop_bridge

        self._client: _BridgeClient | None = None
        self._clips: deque[StoredClip] = deque(maxlen=max(1, settings.eufy_clip_ring_buffer_size))
        self._clip_ids: set[str] = set()
        self._thumbnail_cache: OrderedDict[str, bytes] = OrderedDict()
        self._status: EufySourceStatus = "connecting"
        self._cameras_online = False
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._stopped = asyncio.Event()

    def _default_client_factory(self) -> _BridgeClient:
        from app.eufy.client import EufyBridgeClient

        url = f"ws://{self._settings.eufy_bridge_host}:{self._settings.eufy_bridge_port}"
        return EufyBridgeClient(url)

    # -- read-only surface, used by the API layer ---------------------------

    def snapshot(self) -> CameraGallerySnapshot:
        return CameraGallerySnapshot(
            clips=list(self._clips),
            source_status=self._status,
            cameras_online=self._cameras_online,
        )

    def status(self) -> EufySourceStatus:
        return self._status

    def has_clip(self, clip_id: str) -> bool:
        return clip_id in self._clip_ids

    async def get_thumbnail(self, clip_id: str) -> bytes | None:
        """Cached-decoded-JPEG bytes for one clip, or ``None`` if the clip is
        unknown or the bridge could not resolve it in time. Decoded once per
        clip — a repeat render of the gallery never re-asks the bridge."""
        cached = self._thumbnail_cache.get(clip_id)
        if cached is not None:
            self._thumbnail_cache.move_to_end(clip_id)
            return cached
        if not self.has_clip(clip_id):
            return None
        try:
            response = await self._request(
                "get_thumbnail", {"clip_id": clip_id}, timeout=THUMBNAIL_REQUEST_TIMEOUT_SECONDS
            )
        except (TimeoutError, EufyBridgeUnavailable):
            return None
        data_b64 = response.get("data_base64")
        if not isinstance(data_b64, str):
            return None
        try:
            data = base64.b64decode(data_b64, validate=True)
        except (ValueError, binascii.Error):
            return None
        self._cache_thumbnail(clip_id, data)
        return data

    async def get_video_path(self, clip_id: str) -> Path | None:
        """Trigger (or reuse) a decrypted, muxed local file for one clip.
        ``None`` if the clip is unknown, the bridge could not retrieve it, or
        it timed out — the caller never distinguishes why, only that the video
        isn't available right now."""
        if not self.has_clip(clip_id):
            return None
        try:
            response = await self._request(
                "retrieve_clip", {"clip_id": clip_id}, timeout=VIDEO_REQUEST_TIMEOUT_SECONDS
            )
        except (TimeoutError, EufyBridgeUnavailable):
            return None
        if response.get("error"):
            logger.warning("eufy: clip retrieval failed for %s: %s", clip_id, response["error"])
            return None
        path = response.get("path")
        if not isinstance(path, str):
            return None
        candidate = Path(path)
        return candidate if candidate.is_file() else None

    # -- the run loop ---------------------------------------------------------

    async def run(self) -> None:
        """Connect -> read -> on drop, exponential backoff reconnect (capped),
        forever, while the service is not stopped. Mirrors every other
        reconnect loop in this backend (e.g. `app/voice/relay.py`)."""
        if not self._settings.eufy_enabled:
            return
        backoff = self._settings.eufy_bridge_restart_backoff_seconds
        cap = self._settings.eufy_bridge_restart_backoff_max_seconds
        while not self._stopped.is_set():
            try:
                if self._start_bridge is not None:
                    await self._start_bridge()
                client = self._client_factory()
                await client.connect()
                self._client = client
                await self._set_status("connecting")
                backoff = self._settings.eufy_bridge_restart_backoff_seconds
                await self._read_loop(client)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - one bad tick must not kill the loop
                logger.warning("eufy: bridge connection failed or dropped: %s", exc)
                await self._set_status("error")
            finally:
                if self._client is not None:
                    await self._client.close()
                    self._client = None
                self._fail_pending("the eufy bridge disconnected")
            if self._stopped.is_set():
                break
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=backoff)
            except TimeoutError:
                pass
            backoff = min(backoff * 2, cap)

    async def stop(self) -> None:
        self._stopped.set()
        if self._client is not None:
            await self._client.close()
        self._fail_pending("the eufy service is stopping")
        if self._stop_bridge is not None:
            await self._stop_bridge()

    # -- message handling -----------------------------------------------------

    async def _read_loop(self, client: _BridgeClient) -> None:
        async for message in client.messages():
            await self._handle_message(message)

    async def _handle_message(self, message: dict[str, Any]) -> None:
        request_id = message.get("request_id")
        if isinstance(request_id, str) and request_id in self._pending:
            future = self._pending.pop(request_id)
            if not future.done():
                future.set_result(message)
            return
        kind = message.get("type")
        if kind == "status":
            status = parse_status(message)
            if status is not None:
                await self._set_status(status)
        elif kind == "ready":
            roster = parse_ready(message)
            self._cameras_online = len(roster) > 0
            await self._set_status("connected")
        elif kind == "clip_discovered":
            clip = parse_clip_discovered(message, assumed_fps=self._settings.eufy_assumed_fps)
            if clip is not None:
                await self._add_clip(clip)
        elif kind == "error":
            logger.warning("eufy-bridge reported an error: %s", message.get("message"))

    async def _add_clip(self, clip: StoredClip) -> None:
        if clip.clip_id in self._clip_ids:
            return
        if len(self._clips) == (self._clips.maxlen or 0):
            evicted = self._clips.pop()
            self._clip_ids.discard(evicted.clip_id)
            self._thumbnail_cache.pop(evicted.clip_id, None)
        self._clips.appendleft(clip)
        self._clip_ids.add(clip.clip_id)
        await self._broadcast_snapshot()

    async def _set_status(self, status: EufySourceStatus) -> None:
        if status == self._status:
            return
        self._status = status
        await self._broadcast_snapshot()

    async def _broadcast_snapshot(self) -> None:
        await self._broadcast(
            ApplicationMessage(
                type="camera_clips",
                message="camera clip gallery updated",
                camera_clips=list(self._clips),
                camera_status=self._status,
            )
        )

    # -- request/response over the same socket the push stream rides on -------

    async def _request(
        self, request_type: str, payload: dict[str, Any], *, timeout: float
    ) -> dict[str, Any]:
        if self._client is None:
            raise EufyBridgeUnavailable("not connected to the eufy bridge")
        request_id = uuid.uuid4().hex
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            await self._client.send({"type": request_type, "request_id": request_id, **payload})
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(request_id, None)

    def _fail_pending(self, reason: str) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(EufyBridgeUnavailable(reason))
        self._pending.clear()

    def _cache_thumbnail(self, clip_id: str, data: bytes) -> None:
        cache = self._thumbnail_cache
        cache[clip_id] = data
        cache.move_to_end(clip_id)
        while len(cache) > self._settings.eufy_thumbnail_cache_size:
            cache.popitem(last=False)
