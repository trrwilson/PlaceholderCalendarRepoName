"""Durable on-disk cache for the eufy clip gallery: the last few clips'
metadata + thumbnails (and, once fetched, decoded video), so a restart shows
the same gallery immediately instead of an empty one.

This exists because neither upstream discovery path can be re-asked for
history after the fact (docs/eufy-sdk-integration.md): the primary
``databaseQueryByDate`` reconcile has a documented bug that always returns
the same stale old cluster, and the ``history_record_info`` mega-enumerator
query behaves as a drain-once queue — once any session has successfully
queried a record, it stops being offered to future queries, including a
fresh login after a restart. `EufyEventService`'s own in-memory ring buffer
is therefore the *only* record of anything beyond whatever is still
undrained upstream at any moment; losing that on every process restart is
the actual bug this cache closes.

Follows the same single-JSON-file + atomic-write pattern as `app/lists.py` /
`app/privacy.py`. ``manifest.json`` is the one source of truth for what
belongs in the cache — `load()` sweeps any on-disk media file it doesn't
name, so a crash between writing a media file and persisting the manifest
never leaks disk usage past ``capacity``.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from pathlib import Path

from pydantic import ValidationError

from app.models import StoredClip

logger = logging.getLogger(__name__)

MANIFEST_FILENAME = "manifest.json"


def _safe(clip_id: str) -> str:
    """``clip_id`` is ``device_sn:record_id`` — ``:`` is invalid in a Windows
    filename (reserved for drive letters / alternate data streams)."""
    return clip_id.replace(":", "_").replace("/", "_").replace("\\", "_")


class EufyClipCache:
    """One durable cache directory. Single-event-loop-owner, same assumption
    every other feature store in this codebase makes — not thread-safe."""

    def __init__(self, directory: str | os.PathLike[str], *, capacity: int) -> None:
        self._dir = Path(directory)
        self._capacity = max(1, capacity)
        self._clips: list[StoredClip] = []  # newest-first, mirrors the manifest

    @property
    def clips(self) -> list[StoredClip]:
        return list(self._clips)

    def _manifest_path(self) -> Path:
        return self._dir / MANIFEST_FILENAME

    def _thumb_path(self, clip_id: str) -> Path:
        return self._dir / f"{_safe(clip_id)}.thumb.jpg"

    def _video_path(self, clip_id: str) -> Path:
        return self._dir / f"{_safe(clip_id)}.mp4"

    # -- startup ---------------------------------------------------------

    def load(self) -> None:
        """Read the manifest (missing/corrupt -> start empty, matching
        `ListStore`/`PrivacyStore`) and sweep any on-disk media file the
        manifest doesn't name. Cheap local disk I/O — safe to call
        synchronously from `EufyEventService.__init__` so a fresh process's
        `snapshot()` is cache-backed before the bridge, or even `run()`, has
        been touched."""
        self._dir.mkdir(parents=True, exist_ok=True)
        path = self._manifest_path()
        clips: list[StoredClip] = []
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                clips = [StoredClip.model_validate(entry) for entry in raw.get("clips", [])]
            except (OSError, ValueError, ValidationError) as exc:
                logger.warning(
                    "eufy clip cache manifest %s unreadable (%s) -- starting fresh", path, exc
                )
                clips = []
        self._clips = clips[: self._capacity]
        self._sweep_orphans()

    def _sweep_orphans(self) -> None:
        expected = {MANIFEST_FILENAME}
        for clip in self._clips:
            expected.add(self._thumb_path(clip.clip_id).name)
            expected.add(self._video_path(clip.clip_id).name)
        try:
            entries = list(self._dir.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.is_file() and entry.name not in expected:
                try:
                    entry.unlink()
                except OSError:
                    pass

    # -- reads -------------------------------------------------------------

    def thumbnail(self, clip_id: str) -> bytes | None:
        try:
            return self._thumb_path(clip_id).read_bytes()
        except OSError:
            return None

    def video_path(self, clip_id: str) -> Path | None:
        path = self._video_path(clip_id)
        return path if path.is_file() else None

    # -- writes --------------------------------------------------------------

    def remember(self, clip: StoredClip) -> None:
        """A newly-discovered clip: prepend it (newest-first, matching the
        ring buffer's own order), evict whatever falls past ``capacity``
        (deleting its media files too), and persist the manifest. No
        thumbnail yet — `save_thumbnail` attaches one once fetched."""
        self._clips = [c for c in self._clips if c.clip_id != clip.clip_id]
        self._clips.insert(0, clip)
        evicted = self._clips[self._capacity :]
        self._clips = self._clips[: self._capacity]
        for old in evicted:
            self._delete_media(old.clip_id)
        self._persist()

    def save_thumbnail(self, clip_id: str, data: bytes) -> None:
        """No-op for a clip that has since fallen out of the cache — never
        resurrect an evicted entry's file on a late-arriving fetch."""
        if not any(c.clip_id == clip_id for c in self._clips):
            return
        self._write_bytes(self._thumb_path(clip_id), data)

    def save_video(self, clip_id: str, source: Path) -> Path | None:
        """Durably copy an already-decrypted/muxed clip (from the bridge's
        own short-TTL scratch dir) so a later restart, or the bridge being
        offline, can still serve it. ``None`` (no copy made) for a clip no
        longer in the cache."""
        if not any(c.clip_id == clip_id for c in self._clips):
            return None
        dest = self._video_path(clip_id)
        try:
            fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=".video-", suffix=".tmp")
            os.close(fd)
            shutil.copyfile(source, tmp)
            os.replace(tmp, dest)
        except OSError as exc:
            logger.warning("eufy clip cache: could not persist video for %s: %s", clip_id, exc)
            return None
        return dest

    # -- helpers -------------------------------------------------------------

    def _delete_media(self, clip_id: str) -> None:
        for path in (self._thumb_path(clip_id), self._video_path(clip_id)):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    def _write_bytes(self, path: Path, data: bytes) -> None:
        try:
            fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=".tmp-")
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp, path)
        except OSError as exc:
            logger.warning("eufy clip cache: could not write %s: %s", path, exc)

    def _persist(self) -> None:
        payload = {"clips": [c.model_dump(mode="json") for c in self._clips]}
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=".manifest-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
            os.replace(tmp, self._manifest_path())
        except OSError as exc:  # noqa: BLE001 - persistence is best-effort
            logger.warning("eufy clip cache: could not persist manifest: %s", exc)
