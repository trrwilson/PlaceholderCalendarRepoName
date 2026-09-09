"""Backend-owned brightness of the physical wall panel + the OS effector seam.

The backend is the single source of truth for the panel's brightness: a browser
tab cannot set Windows display brightness, but the deployment topology puts this
process on the same host as the kiosk (asserted by
``MISSION_CONTROL_HOST_LOCAL_DISPLAY`` — see ``app/host.py``). Same mould as
``TimerStore`` / ``PrivacyStore``: an injected clock and broadcast callback, **no
WebSocket import**, a process singleton, and every change pushed to the kiosk over
``/api/ws`` as ``ApplicationMessage.display``.

This is stage 1 of ``docs/display-dimming-plan.md``: the colocation seam, the
``wmi`` and ``ddcci`` effectors, ``GET`` / ``PUT /api/display``, and the
``set_night_mode`` voice tool. The idle-inactivity policy, the ``gamma`` /
``overlay`` mechanisms, and the ``asleep`` level are later phases.

**Fail-safe:** any effector error is recorded in ``DisplayState.last_error`` and
the panel is treated as reachable-at-its-last-known-level rather than stuck; on
backend shutdown the panel is always restored to its reference brightness.
"""

from __future__ import annotations

import asyncio
import ctypes
import logging
import subprocess
import sys
from collections.abc import Awaitable, Callable
from ctypes import wintypes
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
        # ``Get-CimInstance`` / ``Invoke-CimMethod`` failures are non-terminating:
        # without this prefix PowerShell writes the error to stderr but still
        # exits 0, so a dud ``WmiSetBrightness`` would look like success.
        return subprocess.run(
            [
                "powershell.exe", "-NoProfile", "-NonInteractive",
                "-Command", f"$ErrorActionPreference='Stop'; {script}",
            ],
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


# -- DDC/CI (external monitors) ---------------------------------------------
# VESA MCCS VCP feature 0x10 is "luminance". ``dxva2.dll``'s GetMonitorBrightness
# / SetMonitorBrightness wrap exactly that feature and additionally report the
# panel's own min/max, so we scale our 0-100 percentage into that native range.
# ``ctypes`` prototypes are declared explicitly — an undeclared HANDLE argument
# is marshalled as a 32-bit int and truncates real 64-bit monitor handles.

if sys.platform == "win32":

    class _PhysicalMonitor(ctypes.Structure):
        _fields_ = (
            ("handle", wintypes.HANDLE),
            ("description", wintypes.WCHAR * 128),
        )

    _MONITOR_ENUM_PROC = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HMONITOR,
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        wintypes.LPARAM,
    )


def _dxva2() -> ctypes.WinDLL:
    lib = ctypes.WinDLL("dxva2", use_last_error=True)
    dword_p = ctypes.POINTER(wintypes.DWORD)
    lib.GetNumberOfPhysicalMonitorsFromHMONITOR.argtypes = [wintypes.HMONITOR, dword_p]
    lib.GetNumberOfPhysicalMonitorsFromHMONITOR.restype = wintypes.BOOL
    lib.GetPhysicalMonitorsFromHMONITOR.argtypes = [
        wintypes.HMONITOR,
        wintypes.DWORD,
        ctypes.POINTER(_PhysicalMonitor),
    ]
    lib.GetPhysicalMonitorsFromHMONITOR.restype = wintypes.BOOL
    lib.DestroyPhysicalMonitor.argtypes = [wintypes.HANDLE]
    lib.DestroyPhysicalMonitor.restype = wintypes.BOOL
    lib.GetMonitorBrightness.argtypes = [wintypes.HANDLE, dword_p, dword_p, dword_p]
    lib.GetMonitorBrightness.restype = wintypes.BOOL
    lib.SetMonitorBrightness.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    lib.SetMonitorBrightness.restype = wintypes.BOOL
    return lib


def _open_physical_monitors() -> list[int]:
    """Every DDC/CI-addressable monitor currently attached. The caller must pass
    the returned handles to :func:`_close_physical_monitors`. Windows only."""
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.EnumDisplayMonitors.argtypes = [
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        _MONITOR_ENUM_PROC,
        wintypes.LPARAM,
    ]
    user32.EnumDisplayMonitors.restype = wintypes.BOOL
    dxva2 = _dxva2()

    hmonitors: list[int] = []

    @_MONITOR_ENUM_PROC
    def _collect(hmon: int, _hdc: int, _rect: object, _lparam: int) -> int:
        hmonitors.append(hmon)
        return True

    if not user32.EnumDisplayMonitors(None, None, _collect, 0):
        raise ctypes.WinError(ctypes.get_last_error())

    handles: list[int] = []
    for hmon in hmonitors:
        count = wintypes.DWORD()
        if not dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, ctypes.byref(count)):
            continue
        if count.value == 0:
            continue
        block = (_PhysicalMonitor * count.value)()
        if not dxva2.GetPhysicalMonitorsFromHMONITOR(hmon, count.value, block):
            continue
        handles.extend(block[i].handle for i in range(count.value))
    return handles


def _close_physical_monitors(handles: list[int]) -> None:
    if not handles:
        return
    dxva2 = _dxva2()
    for handle in handles:
        dxva2.DestroyPhysicalMonitor(handle)


def _ddcci_range(dxva2: ctypes.WinDLL, handle: int) -> tuple[int, int, int] | None:
    """``(minimum, current, maximum)`` in the panel's native luminance units, or
    ``None`` if the monitor does not answer."""
    low, current, high = wintypes.DWORD(), wintypes.DWORD(), wintypes.DWORD()
    if not dxva2.GetMonitorBrightness(
        handle, ctypes.byref(low), ctypes.byref(current), ctypes.byref(high)
    ):
        return None
    return low.value, current.value, high.value


def _as_percent(low: int, current: int, high: int) -> int:
    if high <= low:
        return max(0, min(100, current))
    return max(0, min(100, round((current - low) * 100 / (high - low))))


class DdcCiDisplayController(DisplayController):
    """External monitors that honour DDC/CI, driven over the monitor cable via
    ``dxva2.dll`` — ``ctypes`` only, no new dependency
    (``docs/display-dimming-plan.md``). This is the mechanism for a desktop kiosk
    host wired to a wall panel, where ``wmi`` reports "not supported". All
    attached DDC/CI monitors are moved together; the probe reports the first.
    """

    mechanism = "ddcci"

    def probe(self) -> ProbeResult:
        if sys.platform != "win32":
            return ProbeResult(ok=False, error="DDC/CI brightness control is Windows-only")
        try:
            handles = _open_physical_monitors()
        except OSError as exc:
            return ProbeResult(ok=False, error=_tidy(str(exc)))
        try:
            if not handles:
                return ProbeResult(ok=False, error="no DDC/CI-capable monitor attached")
            dxva2 = _dxva2()
            for handle in handles:
                reading = _ddcci_range(dxva2, handle)
                if reading is not None:
                    return ProbeResult(ok=True, level=_as_percent(*reading))
            return ProbeResult(ok=False, error="monitor did not answer GetMonitorBrightness")
        finally:
            _close_physical_monitors(handles)

    def set_level(self, pct: int) -> None:
        if sys.platform != "win32":
            raise DisplayControlError("DDC/CI brightness control is Windows-only")
        try:
            handles = _open_physical_monitors()
        except OSError as exc:
            raise DisplayControlError(_tidy(str(exc))) from exc
        if not handles:
            raise DisplayControlError("no DDC/CI-capable monitor attached")
        target = max(0, min(100, int(pct)))
        dxva2 = _dxva2()
        try:
            errors: list[str] = []
            for handle in handles:
                reading = _ddcci_range(dxva2, handle)
                low, high = (reading[0], reading[2]) if reading else (0, 100)
                native = low + round(target * (high - low) / 100)
                if not dxva2.SetMonitorBrightness(handle, native):
                    errors.append(str(ctypes.WinError(ctypes.get_last_error())))
            if errors and len(errors) == len(handles):
                raise DisplayControlError(_tidy(errors[0]) or "SetMonitorBrightness failed")
        finally:
            _close_physical_monitors(handles)


class FallbackDisplayController(DisplayController):
    """``auto``: probe each candidate in deployment-preference order and adopt the
    first that verifiably moves the panel, then delegate every call to it."""

    def __init__(self, candidates: list[DisplayController]) -> None:
        self._candidates = candidates
        self._chosen: DisplayController | None = None

    @property
    def mechanism(self) -> DisplayMechanism:  # type: ignore[override]
        return self._chosen.mechanism if self._chosen is not None else "none"

    def probe(self) -> ProbeResult:
        errors: list[str] = []
        for candidate in self._candidates:
            result = candidate.probe()
            if result.ok:
                self._chosen = candidate
                return result
            errors.append(f"{candidate.mechanism}: {result.error or 'unavailable'}")
        return ProbeResult(ok=False, error=_tidy("; ".join(errors)) or "no mechanism available")

    def set_level(self, pct: int) -> None:
        if self._chosen is None:
            raise DisplayControlError("no display mechanism selected")
        self._chosen.set_level(pct)


def build_controller(*, mechanism: str, host_local_display: bool) -> DisplayController:
    """Pick the effector. Every OS call is inert unless the deployment asserts it
    owns the attached panel; ``auto`` then probes ``wmi`` → ``ddcci`` and adopts
    the first that verifiably moves the panel."""
    if not host_local_display or mechanism == "none":
        return NullDisplayController()
    if mechanism == "wmi":
        return WmiDisplayController()
    if mechanism == "ddcci":
        return DdcCiDisplayController()
    if mechanism == "auto":
        return FallbackDisplayController([WmiDisplayController(), DdcCiDisplayController()])
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
