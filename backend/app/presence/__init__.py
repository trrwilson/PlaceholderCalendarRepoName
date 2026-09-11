"""Process-wide presence wiring: the aggregator singleton, the local-camera
motion source, and the presence-driven display-dimming policy — each gated
exactly like ``app/display.py`` gates its OS effector.

Independent gates, deliberately not one flag:

- ``presence_enabled`` — the presence *feature*: the aggregator and
  ``/api/presence*`` routes. On by default (unlike most feature flags in this
  backend) because the aggregator is pure and does zero I/O — constructing it
  is free and safe under pytest and on any host.
- ``host_local_camera`` — the hardware assertion (mirrors
  ``host_local_display``): only when this is also true does anything actually
  open the webcam. Also on by default — an opt-out, so a plain
  ``uvicorn app.main:app`` run just opens whatever webcam the host has — but
  pytest/CI never see that default: ``tests/conftest.py``'s autouse fixture
  forces it off so the test suite never touches real hardware regardless of
  the app-level default.
- ``display_dim_enabled`` — whether presence signals drive the ambient
  dim/restore policy at all. Also on by default; the policy itself is inert
  hardware-wise unless ``host_local_display`` makes ``DisplayStore``'s
  effector real, exactly like every other display mutation in this backend.

Import this package freely — nothing at module import time touches OpenCV or
the camera; ``start_local_camera`` is the one function that does, and it
no-ops unless both relevant gates are open.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from app.models import (
    ActivitySource,
    PresenceScope,
    PresenceSignal,
    PresenceSignalKind,
    PresenceState,
)
from app.presence.aggregator import PresenceAggregator
from app.presence.display_policy import PresenceDisplayPolicy

logger = logging.getLogger(__name__)

KIOSK_SCOPE = PresenceScope(kind="kiosk", id="kiosk")

_aggregator: PresenceAggregator | None = None
_camera_source = None  # LocalCameraMotionSource | None — imported lazily
_display_policy: PresenceDisplayPolicy | None = None
_loop: asyncio.AbstractEventLoop | None = None


def _on_kiosk_state_change(state: PresenceState) -> None:
    # A future consumer of *standing* presence transitions (a real
    # person/presence detector's kind=presence output, not this MVP's
    # motion-only kind=motion) would subscribe here. No-op today.
    del state


def bind_event_loop() -> None:
    """Capture the running event loop so background threads and sync request
    handlers (neither of which run on it) can safely schedule async work via
    ``loop.call_soon_threadsafe`` — see ``app/presence/display_policy.py``.
    Call once from ``app/main.py``'s lifespan startup, on the event loop
    thread."""
    global _loop
    _loop = asyncio.get_running_loop()


def _get_loop() -> asyncio.AbstractEventLoop | None:
    return _loop


def _get_display_policy() -> PresenceDisplayPolicy:
    global _display_policy
    if _display_policy is None:
        from app.config import get_settings
        from app.display import get_display_store

        settings = get_settings()
        _display_policy = PresenceDisplayPolicy(
            display=get_display_store(),
            get_loop=_get_loop,
            dim_timeout_seconds=settings.display_dim_after_seconds,
            dim_target_pct=settings.display_dim_level,
            bright_target_pct=settings.display_dim_restore_level,
        )
    return _display_policy


def note_activity(source: ActivitySource, at: datetime | None = None) -> None:
    """Record a kiosk-scope ``activity`` pulse from ``source`` — the concrete
    function ``camera-support-plan.md``'s "Policy / aggregator wiring" section
    names ``note_activity(source, at)``. In-process and synchronous, so call
    it directly from any handler already running on the event loop (a voice
    turn starting, a confirmed wake-word/keyword detection, a touch) — no
    thread-bridging needed unless the caller itself is off the loop. A no-op
    while presence is disabled.
    """
    aggregator = get_presence_aggregator()
    if aggregator is None:
        return
    aggregator.observe(
        PresenceSignal(
            source_id=source.value,
            scope=KIOSK_SCOPE,
            kind=PresenceSignalKind.activity,
            observed_at=at or datetime.now(),
        )
    )


def get_presence_aggregator() -> PresenceAggregator | None:
    """The process-wide aggregator, or ``None`` while ``presence_enabled`` is
    false. Lazy: a disabled install never even constructs the (cheap, pure)
    aggregator, matching every other feature store's singleton pattern."""
    global _aggregator
    from app.config import get_settings

    settings = get_settings()
    if not settings.presence_enabled:
        return None
    if _aggregator is None:
        on_signal = _get_display_policy().on_signal if settings.display_dim_enabled else None
        _aggregator = PresenceAggregator(
            now=datetime.now,
            on_change=_on_kiosk_state_change,
            on_signal=on_signal,
            inactivity_timeout_seconds=settings.presence_inactivity_timeout_seconds,
        )
    return _aggregator


def start_display_dim_policy() -> None:
    """Kick off the idle-dim countdown. Called once from backend lifespan
    startup, on the event loop thread — a real deployment may sit with no
    presence signal at all before the first one arrives, and the timeout
    should still elapse in that case. A no-op unless both ``presence_enabled``
    and ``display_dim_enabled`` are set.
    """
    from app.config import get_settings

    settings = get_settings()
    if not settings.presence_enabled or not settings.display_dim_enabled:
        return
    # Constructing the aggregator also wires the policy's on_signal into it.
    get_presence_aggregator()
    _get_display_policy().start()


def stop_display_dim_policy() -> None:
    """Cancel any pending idle-dim timer (backend shutdown / test teardown)."""
    if _display_policy is not None:
        _display_policy.stop()


def start_local_camera() -> None:
    """Open the local webcam and start the motion-detector thread.

    Called once from backend lifespan startup. A no-op unless presence is
    enabled *and* ``host_local_camera`` asserts this process owns a physical
    webcam on this host — the same rule ``app/display.py`` applies to the
    panel effector. Idempotent.
    """
    global _camera_source
    from app.config import get_settings

    settings = get_settings()
    aggregator = get_presence_aggregator()
    if aggregator is None or not settings.host_local_camera:
        return
    if _camera_source is not None:
        return
    from app.presence.sources.local_camera import LocalCameraMotionSource

    _camera_source = LocalCameraMotionSource(
        observe=aggregator.observe,
        device=settings.presence_camera_device,
        min_area_ratio=settings.presence_motion_min_area_ratio,
        max_area_ratio=settings.presence_motion_max_area_ratio,
        inference_interval_ms=settings.presence_inference_interval_ms,
    )
    _camera_source.start()


def stop_local_camera() -> None:
    """Backend shutdown: stop the camera thread and release the device."""
    global _camera_source
    if _camera_source is not None:
        _camera_source.stop()
        _camera_source = None


def camera_status() -> str:
    """Current camera state for ``GET /api/presence`` diagnostics.
    ``"disabled"`` whenever the source was never started (presence off, not
    colocated, or OpenCV unavailable)."""
    if _camera_source is None:
        return "disabled"
    return _camera_source.status


def detector_available() -> bool:
    """Whether this MVP's motion-detector dependency (``opencv-python-headless``)
    is importable. Diagnostic only: ``presence_enabled`` stays whatever it is
    regardless — a missing dependency just means the camera source can never
    report anything, surfaced here rather than failing silently."""
    try:
        import cv2  # noqa: F401
    except ImportError:
        return False
    return True


def reset_presence() -> None:
    """Drop the process singletons (tests / a fresh process)."""
    global _aggregator, _camera_source, _display_policy, _loop
    if _camera_source is not None:
        _camera_source.stop()
    if _display_policy is not None:
        _display_policy.stop()
    _aggregator = None
    _camera_source = None
    _display_policy = None
    _loop = None
