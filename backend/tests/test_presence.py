import time
from datetime import datetime, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.models import PresenceScope, PresenceSignal, PresenceSignalKind, PresenceState
from app.presence.aggregator import PresenceAggregator

BASE = datetime(2026, 9, 10, 8, 0, 0)
KIOSK = PresenceScope(kind="kiosk", id="kiosk")


class FakeClock:
    def __init__(self, at: datetime) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def advance(self, seconds: float) -> None:
        self.at += timedelta(seconds=seconds)


def signal(kind: PresenceSignalKind, at: datetime, **kw) -> PresenceSignal:
    return PresenceSignal(source_id="test", scope=KIOSK, kind=kind, observed_at=at, **kw)


# -- PresenceScope / PresenceSignal models -----------------------------------


def test_presence_scope_is_hashable() -> None:
    # PresenceAggregator keys its per-scope state by PresenceScope.
    assert PresenceScope(kind="kiosk", id="kiosk") in {PresenceScope(kind="kiosk", id="kiosk")}


def test_presence_signal_requires_a_value_for_presence_kind() -> None:
    with pytest.raises(ValueError):
        PresenceSignal(
            source_id="x", scope=KIOSK, kind=PresenceSignalKind.presence, observed_at=BASE
        )
    # A boolean value (including False) is accepted.
    PresenceSignal(
        source_id="x",
        scope=KIOSK,
        kind=PresenceSignalKind.presence,
        value=False,
        observed_at=BASE,
    )


# -- PresenceAggregator: hysteresis ------------------------------------------


def test_activity_pulse_clears_absence_immediately() -> None:
    changes: list[PresenceState] = []
    agg = PresenceAggregator(
        now=lambda: BASE, on_change=changes.append, inactivity_timeout_seconds=900
    )
    agg.observe(signal(PresenceSignalKind.presence, BASE, value=False))
    assert agg.state(KIOSK).present is False

    agg.observe(signal(PresenceSignalKind.activity, BASE + timedelta(seconds=1)))
    assert agg.state(KIOSK).present is True
    assert agg.state(KIOSK).last_activity_at == BASE + timedelta(seconds=1)


def test_a_single_absent_observation_does_not_sleep() -> None:
    agg = PresenceAggregator(now=lambda: BASE, inactivity_timeout_seconds=900)
    agg.observe(signal(PresenceSignalKind.presence, BASE, value=True))
    assert agg.state(KIOSK).present is True

    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=5), value=False))
    assert agg.state(KIOSK).present is True  # one miss is not enough


def test_sustained_absence_past_the_timeout_flips_present() -> None:
    agg = PresenceAggregator(now=lambda: BASE, inactivity_timeout_seconds=60)
    agg.observe(signal(PresenceSignalKind.presence, BASE, value=True))

    # Absence clock starts at the *first* False observation (t=1s), not at BASE.
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=1), value=False))
    assert agg.state(KIOSK).present is True
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=59), value=False))
    assert agg.state(KIOSK).present is True  # 58s of continuous absence so far — under the timeout
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=62), value=False))
    assert agg.state(KIOSK).present is False  # 61s of continuous absence — past the timeout


def test_presence_true_or_activity_cancels_a_pending_absence() -> None:
    agg = PresenceAggregator(now=lambda: BASE, inactivity_timeout_seconds=60)
    agg.observe(signal(PresenceSignalKind.presence, BASE, value=True))
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=10), value=False))
    # A fresh presence=True resets the absence timer entirely — the next False
    # starts a brand new absence window, not a continuation of the first one.
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=20), value=True))
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=70), value=False))
    assert agg.state(KIOSK).present is True  # this is the first False of the *new* window


def test_on_change_fires_once_per_transition_not_per_repeat() -> None:
    changes: list[PresenceState] = []
    agg = PresenceAggregator(
        now=lambda: BASE, on_change=changes.append, inactivity_timeout_seconds=60
    )
    agg.observe(signal(PresenceSignalKind.presence, BASE, value=True))
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=1), value=True))
    agg.observe(signal(PresenceSignalKind.presence, BASE + timedelta(seconds=2), value=True))
    assert len(changes) == 1  # present was already True; repeats are not "changes"


def test_motion_advances_last_signal_at_but_never_sets_present() -> None:
    changes: list[PresenceState] = []
    agg = PresenceAggregator(
        now=lambda: BASE, on_change=changes.append, inactivity_timeout_seconds=900
    )
    agg.observe(signal(PresenceSignalKind.motion, BASE, confidence=0.8))
    state = agg.state(KIOSK)
    assert state.present is False  # motion is weaker than presence — no standing claim
    assert state.last_signal_at == BASE
    assert changes == []  # `present` didn't move, so no on_change either

    # A second motion observation still advances last_signal_at (observable via
    # GET /api/presence) even though nothing "changed" from on_change's view.
    agg.observe(signal(PresenceSignalKind.motion, BASE + timedelta(seconds=1), confidence=0.9))
    assert agg.state(KIOSK).last_signal_at == BASE + timedelta(seconds=1)


def test_on_signal_fires_for_every_observation_including_motion() -> None:
    """`on_signal` (unlike `on_change`) fires on every observe() call for the
    scope, regardless of whether `present` moved — this is what the
    display-dim policy needs, since `motion` never reaches `on_change`."""
    signals: list[PresenceState] = []
    agg = PresenceAggregator(now=lambda: BASE, on_signal=signals.append)
    agg.observe(signal(PresenceSignalKind.motion, BASE, confidence=0.8))
    agg.observe(signal(PresenceSignalKind.motion, BASE + timedelta(seconds=1), confidence=0.8))
    assert len(signals) == 2
    assert [s.last_signal_at for s in signals] == [BASE, BASE + timedelta(seconds=1)]


def test_unknown_scope_defaults_to_absent() -> None:
    agg = PresenceAggregator(now=lambda: BASE)
    other = PresenceScope(kind="zone", id="front_door")
    state = agg.state(other)
    assert state.present is False
    assert state.last_signal_at is None


# -- local-camera motion detector: pure image-processing (no camera) --------

cv2 = pytest.importorskip("cv2")
from app.presence.sources.local_camera import foreground_ratio, new_subtractor  # noqa: E402

W, H = 320, 240
MIN_AREA_RATIO = 0.015
MAX_AREA_RATIO = 0.6


def _base_frame(brightness: int, seed: int) -> "np.ndarray":
    rng = np.random.default_rng(seed)
    frame = np.full((H, W, 3), brightness, dtype=np.uint8)
    noise = rng.integers(-4, 5, size=frame.shape, dtype=np.int16)
    return np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def _with_blob(frame: "np.ndarray", x: int, size: int = 60, level: int = 20) -> "np.ndarray":
    out = frame.copy()
    out[H // 2 - size // 2 : H // 2 + size // 2, x : x + size] = level
    return out


def _run(frame_fn, n: int) -> list[float]:
    sub = new_subtractor()
    return [foreground_ratio(sub, frame_fn(i)) for i in range(n)]


def _passes_gate(ratio: float) -> bool:
    return MIN_AREA_RATIO <= ratio <= MAX_AREA_RATIO


def test_gradual_dimming_never_passes_the_motion_gate() -> None:
    """Light getting dimmer must not read as motion (the FA requirement)."""

    def gradual(i: int) -> "np.ndarray":
        brightness = max(120 - (i * 100 / 200), 20)
        return _base_frame(int(brightness), i)

    ratios = _run(gradual, 200)
    assert not any(_passes_gate(r) for r in ratios[10:])  # skip MOG2 warmup


def test_abrupt_full_lights_off_is_rejected_by_the_area_ceiling() -> None:
    """An abrupt, frame-filling brightness change is a scene change, not a
    person — the max-area-ratio ceiling exists specifically for this case
    (MOG2's own shadow suppression only covers a >=50%-of-background floor)."""

    def lights_off(i: int) -> "np.ndarray":
        return _base_frame(120, i) if i < 30 else _base_frame(5, i)

    ratios = _run(lights_off, 60)
    assert not any(_passes_gate(r) for r in ratios[30:])
    assert max(ratios[30:]) > MAX_AREA_RATIO  # confirms this is exercising the ceiling, not a fluke


def test_a_person_sized_blob_crossing_the_frame_passes_the_gate() -> None:
    """The recall requirement: a person-sized moving region must be caught."""

    def walking(i: int) -> "np.ndarray":
        frame = _base_frame(120, i)
        x = int((i / 40) * (W - 60))
        if 5 <= i < 45:
            frame = _with_blob(frame, x)
        return frame

    ratios = _run(walking, 50)
    passing = [r for r in ratios[5:45] if _passes_gate(r)]
    assert len(passing) >= len(ratios[5:45]) // 2  # caught on most frames while crossing


def test_static_scene_with_sensor_noise_does_not_trigger() -> None:
    ratios = _run(lambda i: _base_frame(120, i), 60)
    assert not any(_passes_gate(r) for r in ratios[10:])


# -- note_activity() (the shared voice/touch/wake-word/timer entry point) ---


def test_note_activity_records_a_kiosk_activity_pulse() -> None:
    from app.models import ActivitySource
    from app.presence import get_presence_aggregator, note_activity

    note_activity(ActivitySource.voice)
    state = get_presence_aggregator().state(KIOSK)
    assert state.present is True
    assert state.last_activity_at is not None


def test_note_activity_is_a_harmless_noop_when_presence_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.models import ActivitySource
    from app.presence import note_activity

    monkeypatch.setenv("MISSION_CONTROL_PRESENCE_ENABLED", "false")
    get_settings.cache_clear()
    note_activity(ActivitySource.voice)  # must not raise


# -- API ----------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    return TestClient(app)


def test_presence_enabled_by_default(client: TestClient) -> None:
    body = client.get("/api/presence").json()
    assert body["settings"]["enabled"] is True
    assert body["kiosk_state"]["present"] is False
    # camera_status stays "disabled": lifespan (which would start the camera
    # thread) never runs for a plain TestClient(app) with no `with` block, and
    # conftest.py forces host_local_camera off for the whole suite anyway.
    assert body["camera_status"] == "disabled"


def test_presence_diagnostics_409_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_PRESENCE_ENABLED", "false")
    get_settings.cache_clear()
    client = TestClient(app)
    assert client.get("/api/presence").status_code == 409


def test_presence_activity_204s_even_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_PRESENCE_ENABLED", "false")
    get_settings.cache_clear()
    client = TestClient(app)
    assert client.post("/api/presence/activity", json={"source": "touch"}).status_code == 204


def test_presence_activity_updates_diagnostics(client: TestClient) -> None:
    assert client.post("/api/presence/activity", json={"source": "voice"}).status_code == 204
    body = client.get("/api/presence").json()
    assert body["kiosk_state"]["present"] is True
    assert body["kiosk_state"]["last_activity_at"] is not None


def test_presence_activity_is_not_blocked_by_privacy_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_PRIVACY_MODE_PIN", "8426")
    get_settings.cache_clear()
    client = TestClient(app)
    client.post("/api/privacy/lock")
    assert client.post("/api/presence/activity", json={"source": "touch"}).status_code == 204


def test_host_local_camera_defaults_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """The *application* default is on (opt-out) — a plain `uvicorn
    app.main:app` run should just open whatever webcam the host has. This
    checks the `Settings` field directly rather than through `get_settings()`,
    since conftest.py's autouse fixture deliberately forces the effective
    value off for the whole test suite (see that fixture's docstring)."""
    from app.config import Settings

    monkeypatch.delenv("MISSION_CONTROL_HOST_LOCAL_CAMERA", raising=False)
    assert Settings(_env_file=None).host_local_camera is True


def test_capabilities_reports_host_local_camera(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_HOST_LOCAL_CAMERA", "true")
    get_settings.cache_clear()
    client = TestClient(app)
    assert client.get("/api/capabilities").json()["host_local_camera"] is True


# -- end-to-end: presence signals driving the display-dim policy ------------
# Exercises the real lifespan wiring (config -> aggregator -> policy ->
# DisplayStore), not just the policy in isolation (test_display_policy.py).
# `with TestClient(app) as client:` is required — lifespan only runs inside
# that context (a bare `TestClient(app)` never starts it).


def test_presence_activity_dims_and_restores_the_display(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_DISPLAY_DIM_AFTER_SECONDS", "0.05")
    monkeypatch.setenv("MISSION_CONTROL_DISPLAY_DIM_LEVEL", "0")
    monkeypatch.setenv("MISSION_CONTROL_DISPLAY_DIM_RESTORE_LEVEL", "80")
    get_settings.cache_clear()

    with TestClient(app) as client:
        assert client.get("/api/display").json()["brightness"] == 100

        time.sleep(0.15)
        assert client.get("/api/display").json()["brightness"] == 0

        assert client.post("/api/presence/activity", json={"source": "touch"}).status_code == 204
        # Check promptly: the same signal that restores brightness also resets
        # the idle timer, which will dim again after another 0.05s if nothing
        # else happens — this assertion must land in the window between them.
        time.sleep(0.01)
        assert client.get("/api/display").json()["brightness"] == 80
