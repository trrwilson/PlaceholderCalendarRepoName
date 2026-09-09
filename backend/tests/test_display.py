import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.display import (
    DdcCiDisplayController,
    DisplayControlError,
    DisplayStore,
    FallbackDisplayController,
    NullDisplayController,
    ProbeResult,
    WmiDisplayController,
    _as_percent,
    build_controller,
)
from app.main import app
from app.models import ApplicationMessage


class FakeController:
    """Records every level the store pushes and can be told the probe result."""

    mechanism = "wmi"

    def __init__(self, *, probe: ProbeResult | None = None, fail: bool = False) -> None:
        self._probe = probe or ProbeResult(ok=True, level=100)
        self._fail = fail
        self.levels: list[int] = []

    def probe(self) -> ProbeResult:
        return self._probe

    def set_level(self, pct: int) -> None:
        if self._fail:
            raise DisplayControlError("boom")
        self.levels.append(pct)


def make_store(**kw) -> tuple[DisplayStore, FakeController, list[ApplicationMessage]]:
    sent: list[ApplicationMessage] = []

    async def broadcast(message: ApplicationMessage) -> None:
        sent.append(message)

    controller = kw.pop("controller", None) or FakeController()
    store = DisplayStore(controller=controller, broadcast=broadcast, colocated=True, **kw)
    store.probe()
    return store, controller, sent


# -- controller selection --------------------------------------------------


def test_build_controller_is_inert_without_colocation() -> None:
    assert isinstance(
        build_controller(mechanism="wmi", host_local_display=False), NullDisplayController
    )
    assert isinstance(
        build_controller(mechanism="auto", host_local_display=False), NullDisplayController
    )


def test_build_controller_auto_is_a_wmi_then_ddcci_fallback_when_colocated() -> None:
    controller = build_controller(mechanism="auto", host_local_display=True)
    assert isinstance(controller, FallbackDisplayController)
    assert [type(c) for c in controller._candidates] == [
        WmiDisplayController,
        DdcCiDisplayController,
    ]


def test_build_controller_picks_an_explicit_mechanism() -> None:
    assert isinstance(
        build_controller(mechanism="wmi", host_local_display=True), WmiDisplayController
    )
    assert isinstance(
        build_controller(mechanism="ddcci", host_local_display=True), DdcCiDisplayController
    )


def test_wmi_probe_is_not_ok_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.display.sys.platform", "linux")
    result = WmiDisplayController().probe()
    assert result.ok is False
    assert "Windows" in (result.error or "")


def test_ddcci_probe_is_not_ok_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.display.sys.platform", "linux")
    result = DdcCiDisplayController().probe()
    assert result.ok is False
    assert "Windows" in (result.error or "")


def test_ddcci_set_level_raises_off_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.display.sys.platform", "linux")
    with pytest.raises(DisplayControlError):
        DdcCiDisplayController().set_level(10)


# -- fallback controller -------------------------------------------------


def test_fallback_adopts_the_first_working_mechanism() -> None:
    dead = FakeController(probe=ProbeResult(ok=False, error="not supported"))
    dead.mechanism = "wmi"
    live = FakeController(probe=ProbeResult(ok=True, level=55))
    live.mechanism = "ddcci"
    controller = FallbackDisplayController([dead, live])

    result = controller.probe()
    assert result.ok is True
    assert result.level == 55
    assert controller.mechanism == "ddcci"

    controller.set_level(20)
    assert live.levels == [20]
    assert dead.levels == []


def test_fallback_reports_none_and_collects_errors_when_all_fail() -> None:
    a = FakeController(probe=ProbeResult(ok=False, error="not supported"))
    a.mechanism = "wmi"
    b = FakeController(probe=ProbeResult(ok=False, error="no monitor"))
    b.mechanism = "ddcci"
    controller = FallbackDisplayController([a, b])

    result = controller.probe()
    assert result.ok is False
    assert "wmi: not supported" in (result.error or "")
    assert "ddcci: no monitor" in (result.error or "")
    assert controller.mechanism == "none"
    with pytest.raises(DisplayControlError):
        controller.set_level(10)


def test_as_percent_scales_from_the_panels_native_range() -> None:
    assert _as_percent(0, 50, 100) == 50
    assert _as_percent(0, 128, 255) == 50
    assert _as_percent(20, 20, 80) == 0
    assert _as_percent(0, 5, 0) == 5  # degenerate range: clamp, don't divide by zero


# -- store: probe --------------------------------------------------------


def test_probe_adopts_the_panels_real_level() -> None:
    store, _, _ = make_store(controller=FakeController(probe=ProbeResult(ok=True, level=70)))
    state = store.state()
    assert state.brightness == 70
    assert state.reference_brightness == 70
    assert state.mechanism == "wmi"
    assert state.available is True


def test_failed_probe_falls_back_to_the_default_and_mechanism_none() -> None:
    store, _, _ = make_store(
        controller=FakeController(probe=ProbeResult(ok=False, error="not supported")),
        default_brightness=100,
    )
    state = store.state()
    assert state.brightness == 100
    assert state.mechanism == "none"
    assert state.available is False
    assert state.last_error == "not supported"


# -- store: night mode --------------------------------------------------


async def test_night_mode_dims_to_ten_percent_then_restores() -> None:
    store, controller, sent = make_store(
        controller=FakeController(probe=ProbeResult(ok=True, level=80))
    )

    await store.set_night_mode(True)
    assert store.state().night_mode is True
    assert store.state().brightness == 8  # 10% of the 80 reference
    assert store.state().reference_brightness == 80
    assert controller.levels == [8]

    await store.set_night_mode(False)
    assert store.state().night_mode is False
    assert store.state().brightness == 80
    assert controller.levels == [8, 80]
    assert [m.type for m in sent] == ["display-night-mode", "display-night-mode"]


async def test_night_mode_is_idempotent() -> None:
    store, controller, sent = make_store()
    await store.set_night_mode(True)
    await store.set_night_mode(True)
    await store.set_night_mode(False)
    await store.set_night_mode(False)
    assert len(sent) == 2
    assert len(controller.levels) == 2


async def test_night_mode_reference_is_captured_at_switch_on() -> None:
    store, _, _ = make_store(controller=FakeController(probe=ProbeResult(ok=True, level=100)))
    await store.set_brightness(50)
    await store.set_night_mode(True)
    assert store.state().brightness == 5
    await store.set_night_mode(False)
    assert store.state().brightness == 50


# -- store: explicit brightness --------------------------------------------------


async def test_set_brightness_clamps_and_leaves_night_mode() -> None:
    store, controller, _ = make_store()
    await store.set_night_mode(True)
    await store.set_brightness(150)
    assert store.state().brightness == 100
    assert store.state().night_mode is False


async def test_no_redundant_set_level() -> None:
    store, controller, sent = make_store(
        controller=FakeController(probe=ProbeResult(ok=True, level=60))
    )
    await store.set_brightness(60)  # already 60
    assert controller.levels == []


async def test_effector_error_is_surfaced_not_raised() -> None:
    store, _, _ = make_store(
        controller=FakeController(probe=ProbeResult(ok=True, level=100), fail=True)
    )
    await store.set_night_mode(True)
    assert store.state().last_error == "boom"
    assert store.state().night_mode is True  # intent still recorded


async def test_restore_full_returns_to_reference() -> None:
    store, controller, _ = make_store(
        controller=FakeController(probe=ProbeResult(ok=True, level=90))
    )
    await store.set_night_mode(True)
    await store.restore_full()
    assert store.state().brightness == 90
    assert store.state().night_mode is False
    assert controller.levels[-1] == 90


# -- API ---------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    return TestClient(app)


def test_capabilities_defaults_to_not_colocated(client: TestClient) -> None:
    body = client.get("/api/capabilities").json()
    assert body == {"host_local_display": False}


def test_capabilities_reflects_the_assertion(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_HOST_LOCAL_DISPLAY", "true")
    get_settings.cache_clear()
    with TestClient(app) as client:
        assert client.get("/api/capabilities").json()["host_local_display"] is True


def test_get_display_reports_state(client: TestClient) -> None:
    body = client.get("/api/display").json()
    assert body["mechanism"] == "none"
    assert body["night_mode"] is False
    assert body["brightness"] == 100


def test_put_display_toggles_night_mode(client: TestClient) -> None:
    body = client.put("/api/display", json={"night_mode": True}).json()
    assert body["night_mode"] is True
    assert body["brightness"] == 10
    body = client.put("/api/display", json={"night_mode": False}).json()
    assert body["night_mode"] is False
    assert body["brightness"] == 100


def test_put_display_rejects_an_empty_body(client: TestClient) -> None:
    assert client.put("/api/display", json={}).status_code == 422


def test_put_display_is_blocked_while_privacy_locked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_PRIVACY_MODE_PIN", "8426")
    get_settings.cache_clear()
    client = TestClient(app)
    client.post("/api/privacy/lock")
    assert client.put("/api/display", json={"night_mode": True}).status_code == 423


def test_put_display_broadcasts(client: TestClient) -> None:
    with client.websocket_connect("/api/ws") as ws:
        for _ in range(5):  # connected, timers, lists, privacy, display
            ws.receive_json()
        client.put("/api/display", json={"night_mode": True})
        pushed = ws.receive_json()
        assert pushed["type"] == "display-night-mode"
        assert pushed["display"]["night_mode"] is True
