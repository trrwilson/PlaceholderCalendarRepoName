"""Supervises the eufy-bridge Node child process.

Spawns it, pipes its stdout/stderr into this process's own logger (so bridge
activity shows up in the same console every other `app.*` log line does), and
terminates it cleanly on shutdown. No reconnect policy here — `EufyEventService
.run()` decides when to (re)start a bridge; this module only knows how to run
one.

Credentials reach the bridge as environment variables, not argv (argv is
visible to any other process via `ps` / Task Manager) and never touch this
Python process's own memory beyond passing them through.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from app.config import Settings

logger = logging.getLogger(__name__)


class EufyBridgeProcess:
    """One supervised bridge child process. Not reentrant — one instance per
    running bridge, matching `LocalCameraMotionSource`'s "one hardware owner"
    shape (`app/presence/sources/local_camera.py`)."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._process: asyncio.subprocess.Process | None = None
        self._pump_task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    def _env(self) -> dict[str, str]:
        settings = self._settings
        env = dict(os.environ)
        env.update(
            {
                "EUFY_EMAIL": settings.eufy_email or "",
                "EUFY_PASSWORD": settings.eufy_password or "",
                "EUFY_REGION": settings.eufy_region,
                "EUFY_SESSION_FILE": str(Path(settings.eufy_session_file).resolve()),
                "EUFY_STATION_LAN_IP": settings.eufy_station_lan_ip or "",
                "EUFY_STATION_SERIAL": settings.eufy_station_serial or "",
                "EUFY_CAMERA_NAMES": ",".join(
                    f"{serial}={name}" for serial, name in settings.eufy_camera_names.items()
                ),
                "EUFY_HOST": settings.eufy_bridge_host,
                "EUFY_PORT": str(settings.eufy_bridge_port),
                # Validated in app/config.py against Node's setTimeout overflow —
                # see docs/eufy-sdk-integration.md §5.6.1.
                "EUFY_POLLING_INTERVAL_MINUTES": str(settings.eufy_polling_interval_minutes),
                "EUFY_RECONCILE_INTERVAL_SECONDS": str(settings.eufy_reconcile_interval_seconds),
                "EUFY_RECONCILE_LOOKBACK_MINUTES": str(settings.eufy_reconcile_lookback_minutes),
                "EUFY_CLIP_CACHE_DIR": str(Path(settings.eufy_clip_cache_dir).resolve()),
                "EUFY_CLIP_CACHE_TTL_SECONDS": str(settings.eufy_clip_cache_ttl_seconds),
            }
        )
        return env

    async def start(self) -> None:
        """Spawn the bridge. Raises (``FileNotFoundError``, most likely — no
        Node on PATH, or the bridge's ``node_modules`` was never installed) if
        it cannot start; the caller (``EufyEventService.run()``) decides how to
        classify and retry that."""
        if self.running:
            return
        settings = self._settings
        script = Path(settings.eufy_bridge_script)
        logger.info("eufy: starting bridge (%s %s)", settings.eufy_bridge_node_path, script)
        self._process = await asyncio.create_subprocess_exec(
            settings.eufy_bridge_node_path,
            str(script),
            cwd=str(script.resolve().parent),
            env=self._env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._pump_task = asyncio.create_task(self._pump_output())

    async def _pump_output(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            async for line in process.stdout:
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    logger.info("[eufy-bridge] %s", text)
        except Exception:  # noqa: BLE001 - the pipe closing on shutdown is not an error
            pass

    async def stop(self) -> None:
        process = self._process
        self._process = None
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()
        if self._pump_task is not None:
            self._pump_task.cancel()
            self._pump_task = None
