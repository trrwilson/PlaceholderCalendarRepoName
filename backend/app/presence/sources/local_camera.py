"""The local-webcam presence source — Phase 1 MVP, coarse motion only.

Binds to the host's own webcam and runs a background-subtraction motion
detector continuously while the process is up (the "always-on camera stream"
camera-support-plan.md calls for). This is deliberately **not** person
detection: it answers "did something change in front of the camera just now",
which the presence envelope calls ``motion`` (docs/presence-module-plan.md) —
"a camera's raw motion event, before/without person detection". A future real
presence/person detector is a separate source emitting ``presence`` instead,
added without touching this one (see ``docs/camera-support-plan.md`` step 4).

**Detector choice: OpenCV MOG2 background subtraction, not an ML model.**
``cv2.createBackgroundSubtractorMOG2`` fits a small per-pixel Gaussian mixture
to the recent frame history and continuously re-fits it, so a *slow, frame-wide*
change — the room's ambient light dimming — is absorbed into the model as the
new background rather than flagged; a *fast, spatially localized* change — a
person crossing the frame — is not, and shows up as a foreground blob. That
one property is exactly this task's coarse-vs-nuisance requirement, it ships
in OpenCV core (no extra download, no model weights, so no separate weights
licence to review — see ``docs/credits.md``), and it is cheap enough to run
continuously on a low-resolution downscaled frame. Requiring a minimum
contiguous blob *area* (``min_area_ratio``) on top of that — rather than
reacting to any per-pixel change — is what keeps sensor noise and small
reflections from firing; recall is prioritised over precision by keeping that
floor low (see ``MISSION_CONTROL_PRESENCE_MOTION_MIN_AREA_RATIO``).

Runs in a background thread (``cv2.VideoCapture.read()`` blocks; the native
call releases the GIL) — never inside an async request handler, matching
``docs/camera-support-plan.md``'s "Backend capture + detection" note. Camera
frames never leave this module: only the derived boolean/area-ratio result
becomes a :class:`~app.models.PresenceSignal`.
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from collections.abc import Callable
from datetime import datetime
from typing import TYPE_CHECKING, Literal

from app.models import PresenceScope, PresenceSignal, PresenceSignalKind

if TYPE_CHECKING:
    import numpy as np

logger = logging.getLogger(__name__)

CameraStatus = Literal["ok", "absent", "disconnected", "error", "disabled"]

KIOSK_SCOPE = PresenceScope(kind="kiosk", id="kiosk")

# Downscale before scoring: presence/motion sensing needs neither the webcam's
# native resolution nor its full frame rate (camera-support-plan.md -> "modest
# camera resolution and inference cadence"), and a smaller frame is cheaper to
# run background subtraction on for a continuously-running detector.
_ANALYSIS_SIZE = (320, 240)
# MOG2 marks shadows as 127 (with detectShadows=True) and real foreground as
# 255. A moving shadow is itself caused by a light/geometry change, not an
# object, so keep only definite foreground.
_SHADOW_VS_FOREGROUND_THRESHOLD = 200
# A contour at exactly `min_area_ratio` reports confidence ~0.4; one at 4x that
# (a person filling a good fraction of a modest-FOV webcam frame) saturates to
# 1.0. Informational only — this MVP gates on the area ratio, not this value.
_CONFIDENCE_SATURATION_MULTIPLE = 4
# How long to back off after a failed camera open before retrying, growing on
# repeated failures so an unplugged webcam does not spin a thread hot.
_INITIAL_RETRY_SECONDS = 1.0
_MAX_RETRY_SECONDS = 30.0
# A known DirectShow/UVC failure mode: after a USB power-management hiccup or
# reconnect, `capture.read()` can keep returning `True` forever with a stale
# or frozen buffer (or simply block in native code) without ever reporting a
# disconnect — invisible to the reconnect logic above, which only reacts to
# `read()` explicitly failing. A watchdog thread force-reopens the capture if
# no frame has changed in this long while `status` still claims "ok".
_STALE_FRAME_TIMEOUT_SECONDS = 10.0
_WATCHDOG_POLL_SECONDS = 2.0
# A genuinely live capture never returns bit-identical consecutive frames —
# sensor noise alone guarantees some difference. A near-zero mean diff
# between frames is the frozen-stream tell.
_STALE_FRAME_DIFF_EPSILON = 0.05


def frame_changed(
    prev: np.ndarray | None, frame: np.ndarray, epsilon: float = _STALE_FRAME_DIFF_EPSILON
) -> bool:
    """Whether `frame` differs meaningfully from `prev` — or there is no
    `prev` yet. Pure and cheap (one `absdiff` + mean over a downscaled
    frame), so the watchdog's staleness check is exercisable without a
    camera."""
    import cv2

    if prev is None:
        return True
    return float(cv2.absdiff(frame, prev).mean()) > epsilon


def _kernel() -> np.ndarray:
    import numpy as np

    return np.ones((3, 3), np.uint8)


def foreground_ratio(subtractor, frame: np.ndarray) -> float:
    """Apply `subtractor` to `frame` and return the largest contiguous
    foreground blob's area as a fraction of the frame.

    Pure with respect to `frame` — the running background model is state
    inside `subtractor` (OpenCV's own stateful API), so calling this
    repeatedly with successive frames is what lets the model adapt to slow
    lighting drift. Exercised directly in tests with synthetic frames — no
    camera required.
    """
    import cv2

    mask = subtractor.apply(frame)
    _, mask = cv2.threshold(mask, _SHADOW_VS_FOREGROUND_THRESHOLD, 255, cv2.THRESH_BINARY)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, _kernel(), iterations=1)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 0.0
    largest = max(cv2.contourArea(c) for c in contours)
    return largest / (frame.shape[0] * frame.shape[1])


def new_subtractor():
    """A fresh MOG2 background subtractor with this module's tuning."""
    import cv2

    return cv2.createBackgroundSubtractorMOG2(history=200, varThreshold=32, detectShadows=True)


class LocalCameraMotionSource:
    """Owns the webcam: opens it once, reads continuously on a daemon thread,
    and calls `observe` with a `motion` :class:`PresenceSignal` whenever
    `foreground_ratio` clears `min_area_ratio`.

    Reopens with backoff on disconnect (`read()` returns `False`, it does not
    raise) rather than crashing the thread — `status` surfaces the current
    camera state for `GET /api/presence` diagnostics and fails safe (a lost
    camera reports `"disconnected"`, never a false `"absent"`).

    A second daemon thread (`_watchdog_run`) guards against the failure mode
    that backoff-on-disconnect can't see: a capture that keeps reporting
    `"ok"` while `read()` silently stalls or returns a frozen buffer forever.
    """

    def __init__(
        self,
        *,
        observe: Callable[[PresenceSignal], None],
        device: str | None,
        min_area_ratio: float,
        max_area_ratio: float,
        inference_interval_ms: int,
        now: Callable[[], datetime] = datetime.now,
    ) -> None:
        self._observe = observe
        self._device = device
        self._min_area_ratio = min_area_ratio
        self._max_area_ratio = max_area_ratio
        self._interval_seconds = max(inference_interval_ms, 1) / 1000
        self._now = now
        self._status: CameraStatus = "disabled"
        self._status_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._watchdog_thread: threading.Thread | None = None
        # Liveness clock the watchdog reads from a different thread than the
        # one that writes it — kept as its own small lock rather than reused
        # off `_status_lock`, since the two are updated independently.
        self._liveness_lock = threading.Lock()
        self._last_live_frame_at = time.monotonic()
        # The currently-open capture, mirrored here (only) so the watchdog
        # can force it closed from outside `_run`'s thread — the standard
        # way to unstick a thread blocked inside a native `read()` call.
        self._capture_lock = threading.Lock()
        self._capture = None

    @property
    def status(self) -> CameraStatus:
        with self._status_lock:
            return self._status

    def _set_status(self, status: CameraStatus) -> None:
        with self._status_lock:
            changed = status != self._status
            self._status = status
        if changed:
            logger.info("presence: local camera status -> %s", status)

    def _touch_alive(self) -> None:
        with self._liveness_lock:
            self._last_live_frame_at = time.monotonic()

    def _seconds_since_alive(self) -> float:
        with self._liveness_lock:
            return time.monotonic() - self._last_live_frame_at

    def _watchdog_should_reopen(self, status: CameraStatus, seconds_since_alive: float) -> bool:
        """Pure decision the watchdog thread acts on — split out so it's
        testable without threads or a camera."""
        return status == "ok" and seconds_since_alive >= _STALE_FRAME_TIMEOUT_SECONDS

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._set_status("absent")
        self._touch_alive()
        self._thread = threading.Thread(target=self._run, name="presence-local-camera", daemon=True)
        self._thread.start()
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_run, name="presence-local-camera-watchdog", daemon=True
        )
        self._watchdog_thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._watchdog_thread is not None:
            self._watchdog_thread.join(timeout=5)
        self._thread = None
        self._watchdog_thread = None
        with self._capture_lock:
            self._capture = None
        self._set_status("disabled")

    def _watchdog_run(self) -> None:
        while not self._stop.wait(_WATCHDOG_POLL_SECONDS):
            if not self._watchdog_should_reopen(self.status, self._seconds_since_alive()):
                continue
            with self._capture_lock:
                capture, self._capture = self._capture, None
            if capture is None:
                continue
            logger.warning(
                "presence: local camera watchdog forcing reopen (no live frame for %.0fs)",
                _STALE_FRAME_TIMEOUT_SECONDS,
            )
            capture.release()
            # Avoid re-firing every poll interval while `_run` notices the
            # forced release and works through its own reconnect backoff.
            self._touch_alive()

    def _open_capture(self):
        import cv2

        target: int | str = 0
        if self._device:
            target = int(self._device) if self._device.isdigit() else self._device
        # DSHOW opens faster and negotiates resolution more reliably than the
        # MSMF default on many UVC webcams (Windows only; index devices only —
        # a device *path* stays on the platform default backend).
        if sys.platform == "win32" and isinstance(target, int):
            capture = cv2.VideoCapture(target, cv2.CAP_DSHOW)
        else:
            capture = cv2.VideoCapture(target)
        if not capture.isOpened():
            capture.release()
            return None
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, _ANALYSIS_SIZE[0])
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, _ANALYSIS_SIZE[1])
        return capture

    def _run(self) -> None:
        import cv2

        capture = None
        subtractor = None
        prev_frame = None
        backoff = _INITIAL_RETRY_SECONDS
        ever_opened = False
        try:
            while not self._stop.is_set():
                if capture is None:
                    capture = self._open_capture()
                    if capture is None:
                        # "absent": never seen this device work at all (no webcam,
                        # or nothing on this index/path). "disconnected": it was
                        # open before and just dropped — a real reliability event
                        # worth distinguishing (docs/camera-support-plan.md
                        # "Reliability" -> "webcam absent" vs "disconnected/reconnected").
                        self._set_status("disconnected" if ever_opened else "absent")
                        self._stop.wait(backoff)
                        backoff = min(backoff * 2, _MAX_RETRY_SECONDS)
                        continue
                    backoff = _INITIAL_RETRY_SECONDS
                    ever_opened = True
                    subtractor = new_subtractor()
                    prev_frame = None
                    self._touch_alive()
                    with self._capture_lock:
                        self._capture = capture
                    self._set_status("ok")
                    logger.info("presence: local camera opened (device=%s)", self._device or "auto")

                ok, frame = capture.read()
                if not ok or frame is None:
                    self._set_status("disconnected")
                    with self._capture_lock:
                        self._capture = None
                    capture.release()
                    capture = None
                    continue

                if frame.shape[:2] != (_ANALYSIS_SIZE[1], _ANALYSIS_SIZE[0]):
                    frame = cv2.resize(frame, _ANALYSIS_SIZE)
                if frame_changed(prev_frame, frame):
                    self._touch_alive()
                prev_frame = frame
                self._evaluate(frame, subtractor)
                self._stop.wait(self._interval_seconds)
        except Exception:  # noqa: BLE001 - a detector crash must not take display/backend down
            logger.exception("presence: local camera loop failed")
            self._set_status("error")
        finally:
            with self._capture_lock:
                self._capture = None
            if capture is not None:
                capture.release()

    def _evaluate(self, frame: np.ndarray, subtractor) -> None:
        ratio = foreground_ratio(subtractor, frame)
        # Below the floor: not enough contiguous change to trust (sensor noise,
        # a small reflection). Above the ceiling: too much of the frame changed
        # at once to plausibly be a person — almost always a global brightness/
        # exposure jump the background subtractor hasn't caught up to yet (see
        # `presence_motion_max_area_ratio` in app/config.py).
        if ratio < self._min_area_ratio or ratio > self._max_area_ratio:
            return
        confidence = min(1.0, ratio / (self._min_area_ratio * _CONFIDENCE_SATURATION_MULTIPLE))
        detail = f"largest contour {ratio:.1%} of frame"
        logger.debug("presence: motion observed confidence=%.2f (%s)", confidence, detail)
        self._observe(
            PresenceSignal(
                source_id="local_camera",
                scope=KIOSK_SCOPE,
                kind=PresenceSignalKind.motion,
                confidence=round(confidence, 3),
                detail=detail,
                observed_at=self._now(),
            )
        )
