"""Durable, size-capped on-disk mirror of the household photo stream.

Same single-manifest + atomic-write shape as `app/eufy/cache.py`:
``manifest.json`` is the one source of truth for what belongs in the cache, and
`load()` sweeps any media file it doesn't name, so a crash between writing a
photo and persisting the manifest never leaks disk past the caps. The sync
state (the Graph delta link) lives beside it in ``state.json`` — no new store.

Unlike the eufy cache this is a *mirror with a cap*, not a ring buffer: items
leave when the household removes them upstream, and when the cap is reached new
items are skipped rather than evicting photos the household still curates
(docs/photo-stream-plan.md §3.1). It is touched from the sync worker thread and
from request handlers, so every public method takes one lock.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.models import PhotoItem

logger = logging.getLogger(__name__)

MANIFEST_FILENAME = "manifest.json"
STATE_FILENAME = "state.json"


def _filename(photo_id: str) -> str:
    """Provider ids can contain ``!`` and other characters awkward on Windows;
    a hash is filesystem-safe and stable."""
    return hashlib.sha256(photo_id.encode("utf-8")).hexdigest()[:32] + ".jpg"


class PhotoCache:
    def __init__(
        self, directory: str | os.PathLike[str], *, max_items: int, max_bytes: int
    ) -> None:
        self._dir = Path(directory)
        self._max_items = max(1, max_items)
        self._max_bytes = max(1, max_bytes)
        self._photos: dict[str, PhotoItem] = {}  # insertion order = manifest order
        self._lock = threading.Lock()

    # -- reads ---------------------------------------------------------------

    def photos(self) -> list[PhotoItem]:
        """Stable display order: newest taken first, undated last, then name."""
        with self._lock:
            items = list(self._photos.values())
        return sorted(
            items,
            key=lambda p: (
                p.taken_at is None,
                -(p.taken_at.timestamp() if p.taken_at else 0),
                p.name,
            ),
        )

    def get(self, photo_id: str) -> PhotoItem | None:
        with self._lock:
            return self._photos.get(photo_id)

    def ids(self) -> set[str]:
        with self._lock:
            return set(self._photos)

    def path_for(self, photo_id: str) -> Path | None:
        with self._lock:
            if photo_id not in self._photos:
                return None
        path = self._dir / _filename(photo_id)
        return path if path.is_file() else None

    def total_bytes(self) -> int:
        with self._lock:
            return sum(p.bytes for p in self._photos.values())

    def has_room_for(self, size: int, *, replacing: str | None = None) -> bool:
        with self._lock:
            others = [p for k, p in self._photos.items() if k != replacing]
            return (
                len(others) < self._max_items
                and sum(p.bytes for p in others) + size <= self._max_bytes
            )

    # -- writes --------------------------------------------------------------

    def put(self, item: PhotoItem, data: bytes) -> bool:
        """Store (or replace) one photo. Returns False — and stores nothing — if
        it would exceed a cap or the write fails."""
        item = item.model_copy(update={"bytes": len(data)})
        if not self.has_room_for(len(data), replacing=item.id):
            return False
        self._dir.mkdir(parents=True, exist_ok=True)
        if not self._write_bytes(self._dir / _filename(item.id), data):
            return False
        with self._lock:
            self._photos[item.id] = item
            self._persist_locked()
        return True

    def update_metadata(self, item: PhotoItem) -> None:
        """Rename/metadata-only change with identical bytes (same version)."""
        with self._lock:
            current = self._photos.get(item.id)
            if current is None:
                return
            self._photos[item.id] = item.model_copy(update={"bytes": current.bytes})
            self._persist_locked()

    def remove(self, photo_ids: set[str]) -> int:
        removed = 0
        with self._lock:
            for photo_id in photo_ids:
                if self._photos.pop(photo_id, None) is not None:
                    removed += 1
                    (self._dir / _filename(photo_id)).unlink(missing_ok=True)
            if removed:
                self._persist_locked()
        return removed

    # -- state file ------------------------------------------------------------

    def load_state(self) -> dict[str, Any]:
        try:
            data = json.loads((self._dir / STATE_FILENAME).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def save_state(self, state: dict[str, Any]) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        self._atomic_text(self._dir / STATE_FILENAME, json.dumps(state, indent=2))

    # -- lifecycle -------------------------------------------------------------

    def load(self) -> None:
        """Read the manifest (a missing or corrupt one starts empty) and sweep
        orphaned media files."""
        photos: dict[str, PhotoItem] = {}
        try:
            raw = json.loads((self._dir / MANIFEST_FILENAME).read_text(encoding="utf-8"))
            for entry in raw.get("photos", []):
                try:
                    item = PhotoItem.model_validate(entry)
                except ValidationError:
                    continue
                if (self._dir / _filename(item.id)).is_file():
                    photos[item.id] = item
        except FileNotFoundError:
            pass
        except (OSError, ValueError, AttributeError) as exc:
            logger.warning("photo cache: unreadable manifest, starting empty: %s", exc)
        with self._lock:
            self._photos = photos
        self._sweep_orphans()

    def _sweep_orphans(self) -> None:
        if not self._dir.is_dir():
            return
        with self._lock:
            keep = {_filename(pid) for pid in self._photos}
        for path in self._dir.glob("*.jpg"):
            if path.name not in keep:
                path.unlink(missing_ok=True)

    # -- io --------------------------------------------------------------------

    def _write_bytes(self, path: Path, data: bytes) -> bool:
        try:
            fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=".tmp-")
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp, path)
            return True
        except OSError as exc:
            logger.warning("photo cache: could not write %s: %s", path, exc)
            return False

    def _atomic_text(self, path: Path, text: str) -> None:
        try:
            fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=".tmp-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
            os.replace(tmp, path)
        except OSError as exc:  # persistence is best-effort
            logger.warning("photo cache: could not write %s: %s", path, exc)

    def _persist_locked(self) -> None:
        payload = {"photos": [p.model_dump(mode="json") for p in self._photos.values()]}
        self._dir.mkdir(parents=True, exist_ok=True)
        self._atomic_text(self._dir / MANIFEST_FILENAME, json.dumps(payload, indent=2))
