"""Photo stream sync loop (docs/photo-stream-plan.md §3.1).

Owns one `PhotoCache` and one source. ``run()`` loops on the event loop and
does each sync round on a worker thread; every failure is caught here and only
changes this feature's status — it can never reach the calendar path. Pushes a
``photos`` `ApplicationMessage` after any round that changed what's cached.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Protocol

from app.models import ApplicationMessage, PhotoItem, PhotoStreamSnapshot, PhotoStreamStatus
from app.photos.cache import PhotoCache
from app.photos.onedrive import DeltaResult, NeedsSignIn, PhotoSourceError, Throttled

logger = logging.getLogger(__name__)

MAX_BACKOFF_SECONDS = 3600.0


class PhotoSource(Protocol):
    def resolve_folder(self) -> str: ...
    def changes(self, folder_id: str, delta_link: str | None) -> DeltaResult: ...
    def fetch(self, photo_id: str) -> bytes: ...


class PhotoStreamService:
    def __init__(
        self,
        *,
        source: PhotoSource,
        cache: PhotoCache,
        source_key: str,
        interval_seconds: float,
        broadcast: Callable[[ApplicationMessage], Awaitable[None]] | None = None,
        clock: Callable[[], datetime] = datetime.now,
    ) -> None:
        self._source = source
        self._cache = cache
        # Identifies what the stored delta link belongs to (e.g. the folder
        # path); a config change invalidates the state and forces a full sync.
        self._source_key = source_key
        self._interval = interval_seconds
        self._broadcast = broadcast
        self._clock = clock
        self._status: PhotoStreamStatus = "starting"
        self._detail: str | None = None
        self._last_sync: datetime | None = None
        self._wake = asyncio.Event()
        self._stopping = False
        self._failures = 0
        cache.load()  # cache-backed before any network call
        state = cache.load_state()
        if isinstance(state.get("last_sync"), str):
            try:
                self._last_sync = datetime.fromisoformat(state["last_sync"])
            except ValueError:
                pass

    # -- reads ---------------------------------------------------------------

    def snapshot(self) -> PhotoStreamSnapshot:
        return PhotoStreamSnapshot(
            enabled=True,
            status=self._status,
            photos=self._cache.photos(),
            last_sync=self._last_sync,
            detail=self._detail,
        )

    @property
    def cache(self) -> PhotoCache:
        return self._cache

    # -- control -------------------------------------------------------------

    def request_sync(self) -> None:
        self._wake.set()

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()

    async def run(self) -> None:
        while not self._stopping:
            delay = self._interval
            # Clear before the round, so a request_sync()/stop() that lands
            # during it still wakes the wait below.
            self._wake.clear()
            try:
                changed = await asyncio.to_thread(self.sync_once)
                if changed:
                    await self._push()
            except Throttled as exc:
                delay = exc.retry_after
            except Exception:  # noqa: BLE001 - never let the loop die
                logger.exception("photo stream: unexpected sync failure")
                self._set_status("error", "Photo sync failed")
                self._failures += 1
            if self._failures:
                delay = min(MAX_BACKOFF_SECONDS, self._interval * 2 ** (self._failures - 1))
            if self._stopping:
                break
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=delay)
            except TimeoutError:
                pass

    # -- one round (worker thread) -------------------------------------------

    def sync_once(self) -> bool:
        """One delta round. Returns whether the cached set changed. Raises
        only `Throttled` (the loop honours Retry-After); every other source
        failure becomes a status and returns False."""
        before = {p.id: p.version for p in self._cache.photos()}
        try:
            self._sync()
        except Throttled:
            raise
        except NeedsSignIn as exc:
            logger.info("photo stream: %s", exc)
            self._set_status("needs_sign_in", "Photos need a OneDrive sign-in")
            self._failures += 1
            return False
        except PhotoSourceError as exc:
            logger.warning("photo stream: %s", exc)
            self._set_status("error", str(exc) if "folder" in str(exc) else "Photo sync failed")
            self._failures += 1
            return False
        after = {p.id: p.version for p in self._cache.photos()}
        return before != after

    def _sync(self) -> None:
        state = self._cache.load_state()
        if state.get("source_key") != self._source_key:
            state = {"source_key": self._source_key}
        folder_id = state.get("folder_id") or self._source.resolve_folder()
        result = self._source.changes(folder_id, state.get("delta_link") or None)

        complete = True
        if result.full:
            seen = {item.id for item in result.upserts}
            self._cache.remove(self._cache.ids() - seen)
        self._cache.remove(result.deleted)
        # Newest first so a capped cache keeps the most recent photos.
        upserts = sorted(
            result.upserts,
            key=lambda p: p.taken_at.timestamp() if p.taken_at else 0.0,
            reverse=True,
        )
        for item in upserts:
            if not self._store(item):
                complete = False

        self._last_sync = self._clock()
        state.update(folder_id=folder_id, last_sync=self._last_sync.isoformat())
        # Never advance the delta link past work that isn't on disk: a failed
        # download is retried next round (already-cached versions are skipped).
        if complete:
            state["delta_link"] = result.delta_link
        self._cache.save_state(state)
        self._failures = 0
        self._set_status("ok", None)

    def _store(self, item: PhotoItem) -> bool:
        """Download + cache one photo. True when done or deliberately skipped
        (cap reached); False when it should be retried."""
        current = self._cache.get(item.id)
        if current is not None and current.version == item.version:
            if current != item.model_copy(update={"bytes": current.bytes}):
                self._cache.update_metadata(item)
            return True
        if current is None and not self._cache.has_room_for(0):
            return True  # cap reached: skip, don't evict curated photos
        try:
            data = self._source.fetch(item.id)
        except Throttled:
            raise
        except PhotoSourceError as exc:
            logger.info("photo stream: could not fetch %s: %s", item.name, exc)
            return False
        if not self._cache.put(item, data):
            logger.info("photo stream: cache cap reached, skipped %s", item.name)
        return True

    def _set_status(self, status: PhotoStreamStatus, detail: str | None) -> None:
        self._status, self._detail = status, detail

    async def _push(self) -> None:
        if self._broadcast is None:
            return
        try:
            await self._broadcast(
                ApplicationMessage(
                    type="photos", message="photo stream updated", photos=self.snapshot()
                )
            )
        except Exception:  # noqa: BLE001 - a push failure never breaks sync
            logger.exception("photo stream: broadcast failed")
