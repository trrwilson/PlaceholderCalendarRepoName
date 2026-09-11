"""Process-wide eufy wiring: the `EufyEventService` singleton + its supervised
bridge child process, gated by `eufy_enabled` exactly like `app/presence/`
gates the camera thread and `app/display.py` gates its OS effector.

Import this package freely — nothing at module import time touches Node,
websockets, or the network; `start_eufy_service()` is the one function that
does, and it no-ops unless `eufy_enabled` is set.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.eufy.bridge_process import EufyBridgeProcess
    from app.eufy.service import EufyEventService

logger = logging.getLogger(__name__)

_service: EufyEventService | None = None
_bridge: EufyBridgeProcess | None = None
_task: asyncio.Task[None] | None = None


def get_eufy_service() -> EufyEventService | None:
    """The process-wide `EufyEventService`, or `None` while `eufy_enabled` is
    false. Lazy: a disabled install never imports `app.eufy.service` /
    `app.eufy.client` / the bridge supervisor."""
    global _service, _bridge
    from app.config import get_settings

    settings = get_settings()
    if not settings.eufy_enabled:
        return None
    if _service is None:
        from app.eufy.bridge_process import EufyBridgeProcess
        from app.eufy.service import EufyEventService
        from app.realtime import connections

        Path(settings.eufy_clip_cache_dir).mkdir(parents=True, exist_ok=True)
        _bridge = EufyBridgeProcess(settings)
        _service = EufyEventService(
            settings=settings,
            broadcast=connections.broadcast,
            start_bridge=_bridge.start,
            stop_bridge=_bridge.stop,
        )
    return _service


def start_eufy_service() -> None:
    """Launch `service.run()` as a background task. Called once from backend
    lifespan startup, on the event loop thread. A no-op unless `eufy_enabled`
    (or if already started)."""
    global _task
    service = get_eufy_service()
    if service is None or _task is not None:
        return
    _task = asyncio.create_task(service.run())


async def stop_eufy_service() -> None:
    """Stop the service (which stops the bridge process) and cancel the
    background task. Backend shutdown."""
    global _task
    if _service is not None:
        await _service.stop()
    if _task is not None:
        task, _task = _task, None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 - shutdown must not raise
            logger.exception("eufy: error while stopping the run loop")


def reset_eufy_service() -> None:
    """Drop the process singletons (tests / a fresh process). Synchronous —
    fine for test teardown even if a real task is running, since the event
    loop is torn down right after; production shutdown should use
    `stop_eufy_service()` instead so the bridge child process actually exits."""
    global _service, _bridge, _task
    if _task is not None:
        _task.cancel()
    _service = None
    _bridge = None
    _task = None
