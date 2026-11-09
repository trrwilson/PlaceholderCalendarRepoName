"""Household photo stream: a curated OneDrive folder mirrored to disk and shown
as a Home slideshow tile (docs/photo-stream-plan.md).

Feature-flagged and severable like `app.eufy`: while ``photos_enabled`` is
false nothing below is imported and no sync loop runs.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.photos.service import PhotoStreamService

_service: PhotoStreamService | None = None
_task: asyncio.Task[None] | None = None


def _token_provider():
    """Silent ``Files.Read`` token for the configured account from the shared
    personal-account MSAL cache (`app/calendar/outlook_personal.py`)."""
    from app.calendar.outlook_personal import save_cache, shared_msal_app
    from app.config import get_settings
    from app.photos.onedrive import NeedsSignIn

    def acquire() -> str:
        settings = get_settings()
        app, cache, path = shared_msal_app(settings)
        accounts = app.get_accounts()
        wanted = (settings.photos_account or "").strip().lower()
        if wanted:
            accounts = [a for a in accounts if str(a.get("username", "")).lower() == wanted]
        if not accounts:
            raise NeedsSignIn("no signed-in account for the photo stream")
        result = app.acquire_token_silent(["Files.Read"], account=accounts[0])
        save_cache(cache, path)
        if not result or "access_token" not in result:
            raise NeedsSignIn("no Files.Read grant — sign in again with photos enabled")
        return str(result["access_token"])

    return acquire


def get_photo_service() -> PhotoStreamService | None:
    global _service
    from app.config import get_settings

    settings = get_settings()
    if not settings.photos_enabled:
        return None
    if _service is None:
        from app.photos.cache import PhotoCache
        from app.photos.onedrive import OneDriveFolderSource
        from app.photos.service import PhotoStreamService
        from app.realtime import connections

        _service = PhotoStreamService(
            source=OneDriveFolderSource(
                token_provider=_token_provider(),
                folder_path=settings.photos_folder_path,
                rendition=settings.photos_rendition,
            ),
            cache=PhotoCache(
                settings.photos_cache_dir,
                max_items=settings.photos_cache_max_items,
                max_bytes=settings.photos_cache_max_mb * 1024 * 1024,
            ),
            source_key=":".join(
                ("onedrive_folder", settings.photos_account or "", settings.photos_folder_path)
            ),
            interval_seconds=settings.photos_sync_interval_seconds,
            broadcast=connections.broadcast,
        )
    return _service


def start_photo_service() -> None:
    global _task
    service = get_photo_service()
    if service is None or _task is not None:
        return
    _task = asyncio.create_task(service.run())


async def stop_photo_service() -> None:
    global _task
    if _service is not None:
        await _service.stop()
    if _task is not None:
        task, _task = _task, None
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


def _reset_for_tests() -> None:
    global _service, _task
    _service, _task = None, None
