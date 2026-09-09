"""Backend-owned brightness of the physical wall panel + the OS effector seam.

The backend is the single source of truth for the panel's brightness: a browser
tab cannot set Windows display brightness, but the deployment topology puts this
process on the same host as the kiosk (asserted by
``MISSION_CONTROL_HOST_LOCAL_DISPLAY`` — see ``app/host.py``). Same mould as
``TimerStore`` / ``PrivacyStore``: an injected clock and broadcast callback, **no
WebSocket import**, a process singleton, and every change pushed to the kiosk over
``/api/ws`` as ``ApplicationMessage.display``.

This is stage 1 of ``docs/display-dimming-plan.md``: the colocation seam, a
``wmi`` effector, ``GET`` / ``PUT /api/display``, and the ``set_night_mode``
voice tool. The idle-inactivity policy, the ``ddcci`` / ``gamma`` mechanisms, and
the ``asleep`` level are later phases.

**Fail-safe:** any effector error is recorded in ``DisplayState.last_error`` and
the panel is treated as reachable-at-its-last-known-level rather than stuck; on
backend shutdown the panel is always restored to its reference brightness.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime

from app.models import ApplicationMessage, DisplayMechanism, DisplayState

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
Broadcast = Callable[[ApplicationMessage], Awaitable[None]]

# PowerShell shell-outs must finish quickly; a wall panel that does not answer WMI
# in a few seconds is treated as unavailable rather than blocking a request.
_POWERSHELL_TIMEOUT = 5.0


async def _noop_broadcast(_message: ApplicationMessage) -> None:
    return None


class DisplayControlError(RuntimeError):
    """The OS refused a brightness change."""


def _tidy(text: str) -> str:
    """Collapse a multi-line PowerShell error into one short line for diagnostics."""
    return " ".join(text.split())[:200]


@dataclass
class ProbeResult:
    ok: bool
    level: int | None = None
    error: str | None = None


class DisplayController:
    """Effector seam. ``set_level`` takes a brightness percentage (0-100).

    The controller stays dumb — "don't re-issue an identical level" and the
    reference/night-mode bookkeeping live in :class:`DisplayStore`.
    """

    mechanism: DisplayMechanism = "none"

    def probe(self) -> ProbeResult:  # pragma: no cover - overridden
        raise NotImplementedError

    def set_level(self, pct: int) -> None:  # pragma: no cover - overridden
        raise NotImplementedError


class NullDisplayController(DisplayController):
    """Dev / CI / any host that is not colocated. Accepts levels, moves nothing."""

    mechanism = "none"

    def probe(self) -> ProbeResult:
        return ProbeResult(ok=False)

    def set_level(self, pct: int) -> None:
        return None


class WmiDisplayController(DisplayController):
    """The Windows OS brightness slider (``WmiMonitorBrightnessMethods`` in
    ``root/wmi``), driven through a PowerShell shell-out — no new runtime
    dependency (``docs/display-dimming-plan.md``). Works on integrated panels and
    monitors that honour it; the startup probe confirms per install.
    """

    mechanism = "wmi"

    def _run(self, script: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=_POWERSHELL_TIMEOUT,
            check=False,
        )

    def probe(self) -> ProbeResult:
        if sys.platform != "win32":
            return ProbeResult(ok=False, error="WMI brightness control is Windows-only")
        try:
            proc = self._run(
                "(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness)"
                ".CurrentBrightness"
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return ProbeResult(ok=False, error=_tidy(str(exc)))
        lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
        if proc.returncode != 0 or not lines:
            detail = proc.stderr.strip() or "no WmiMonitorBrightness instance on this host"
            return ProbeResult(ok=False, error=_tidy(detail))
        try:
            level = int(lines[0])
        except ValueError:
            return ProbeResult(ok=False, error=f"unexpected probe output: {lines[0]!r}")
        return ProbeResult(ok=True, level=max(0, min(100, level)))

    def set_level(self, pct: int) -> None:
        try:
            proc = self._run(
                "Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods "
                "| Invoke-CimMethod -MethodName WmiSetBrightness "
                f"-Arguments @{{Timeout=0;Brightness={int(pct)}}}"
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise DisplayControlError(_tidy(str(exc))) from exc
        if proc.returncode != 0:
            raise DisplayControlError(_tidy(proc.stderr) or "WmiSetBrightness failed")


def build_controller(*, mechanism: str, host_local_display: bool) -> DisplayController:
    """Pick the effector. Every OS call is inert unless the deployment asserts it
    owns the attached panel; ``auto`` then tries ``wmi`` (the probe decides)."""
    if not host_local_display or mechanism == "none":
        return NullDisplayController()
    if mechanism in ("auto", "wmi"):
        return WmiDisplayController()
    return NullDisplayController()


class DisplayStore:
    def __init__(
        self,
        *,
        controller: DisplayController | None = None,
        broadcast: Broadcast | None = None,
        clock: Clock | None = None,
        default_brightness: int = 100,
        night_mode_level_pct: int = 10,
        colocated: bool = False,
    ) -> None:
        self._controller: DisplayController = controller or NullDisplayController()
        self._broadcast: Broadcast = broadcast or _noop_broadcast
        # Unused today; kept for parity with the other stores and the inactivity
        # policy a later phase adds.
        self._clock: Clock = clock or datetime.now
        self._night_pct = max(1, min(100, night_mode_level_pct))
        self._colocated = colocated

        self._brightness = max(0, min(100, default_brightness))
        self._reference = self._brightness
        self._night_mode = False
        self._available = False
        self._last_error: str | None = None

    # -- probe -------------------------------------------------------------

    def probe(self) -> None:
        """Blocking startup probe. Records whether the effector verifiably moves
        the panel and, when it can read one, the panel's real current level."""
        result = self._controller.probe()
        self._available = result.ok
        self._last_error = result.error
        if result.ok and result.level is not None:
            self._brightness = result.level
            self._reference = result.level
        logger.info(
            "display: mechanism=%s available=%s brightness=%s%s",
            self._mechanism,
            self._available,
            self._brightness,
            f" ({result.error})" if result.error else "",
        )

    # -- reads -----------------------------------------------------------------

    @property
    def _mechanism(self) -> DisplayMechanism:
        return self._controller.mechanism if self._available else "none"

    def state(self) -> DisplayState:
        return DisplayState(
            brightness=self._brightness,
            reference_brightness=self._reference,
            night_mode=self._night_mode,
            mechanism=self._mechanism,
            colocated=self._colocated,
            available=self._available,
            last_error=self._last_error,
        )

    # -- mutations -----------------------------------------------------------------

    async def set_brightness(self, pct: int) -> DisplayState:
        """Set the panel to an explicit level (0-100). An explicit level leaves
        night mode (its reference is no longer meaningful)."""
        target = max(0, min(100, int(pct)))
        changed = target != self._brightness or self._night_mode
        self._night_mode = False
        if target != self._brightness:
            await self._apply(target)
        if changed:
            await self._emit("display-brightness")
        return self.state()

    async def set_night_mode(self, on: bool) -> DisplayState:
        """Night mode dims the panel to a fraction of the brightness it had when
        switched on, and restores exactly that level when switched off.
        Idempotent."""
        if on and not self._night_mode:
            self._reference = self._brightness
            self._night_mode = True
            await self._apply(max(1, round(self._reference * self._night_pct / 100)))
            await self._emit("display-night-mode")
        elif not on and self._night_mode:
            self._night_mode = False
            await self._apply(self._reference)
            await self._emit("display-night-mode")
        return self.state()

    async def restore_full(self) -> None:
        """Backend shutdown / teardown: return the panel to its reference
        brightness so a dimming feature can never leave the wall stuck dim."""
        self._night_mode = False
        if self._brightness != self._reference:
            await self._apply(self._reference)

    def clear(self) -> None:
        """Sync reset without an effector call or broadcast (tests)."""
        self._night_mode = False
        self._brightness = self._reference

    # -- helpers -----------------------------------------------------------------

    async def _apply(self, pct: int) -> None:
        self._brightness = pct
        if not self._available:
            return
        try:
            await asyncio.to_thread(self._controller.set_level, pct)
            self._last_error = None
        except DisplayControlError as exc:
            self._last_error = str(exc)
            logger.warning("display: set_level(%s) failed: %s", pct, exc)

    async def _emit(self, message_type: str) -> None:
        await self._broadcast(
            ApplicationMessage(type=message_type, message="display state", display=self.state())
        )


# -- process-wide singleton ---------------------------------------------------

_store: DisplayStore | None = None


def get_display_store() -> DisplayStore:
    global _store
    if _store is None:
        from app.config import get_settings
        from app.realtime import connections

        settings = get_settings()
        _store = DisplayStore(
            controller=build_controller(
                mechanism=settings.display_control_mechanism,
                host_local_display=settings.host_local_display,
            ),
            broadcast=connections.broadcast,
            default_brightness=settings.display_default_brightness,
            night_mode_level_pct=settings.display_night_mode_level_pct,
            colocated=settings.host_local_display,
        )
    return _store


def reset_display_store() -> None:
    """Drop the singleton (tests / a fresh process)."""
    global _store
    _store = None
