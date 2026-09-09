from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.main import app
from app.models import ApplicationMessage
from app.privacy import PrivacyStore

BASE = datetime(2026, 9, 7, 19, 12, 0)


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def make_store(clock: FakeClock, **kw) -> tuple[PrivacyStore, list[ApplicationMessage]]:
    sent: list[ApplicationMessage] = []

    async def broadcast(message: ApplicationMessage) -> None:
        sent.append(message)

    kw.setdefault("pin", "8426")
    return PrivacyStore(clock=clock, broadcast=broadcast, **kw), sent


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_PRIVACY_MODE_PIN", "8426")
    get_settings.cache_clear()
    return TestClient(app)


# -- config -----------------------------------------------------------------


@pytest.mark.parametrize("bad", ["123", "12345", "abcd", "12a4"])
def test_pin_must_be_four_digits(bad: str) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, privacy_mode_pin=bad)


def test_blank_pin_is_allowed_and_disables_the_feature() -> None:
    settings = Settings(_env_file=None, privacy_mode_pin="")
    assert settings.privacy_mode_pin == ""


# -- store ----------------------------------------------------------------


async def test_lock_is_idempotent_and_stamps_since() -> None:
    store, sent = make_store(FakeClock(BASE))
    assert store.locked is False
    await store.lock()
    assert store.locked is True
    assert store.state().since == BASE
    await store.lock()  # no second broadcast
    assert [m.type for m in sent] == ["privacy-locked"]


async def test_unlock_with_the_right_pin() -> None:
    store, sent = make_store(FakeClock(BASE))
    await store.lock()
    assert await store.unlock("8426") == "ok"
    assert store.locked is False
    assert store.state().since is None
    assert sent[-1].type == "privacy-unlocked"


async def test_unlock_without_a_configured_pin_is_disabled() -> None:
    store, _ = make_store(FakeClock(BASE), pin="")
    assert store.available is False
    assert await store.unlock("8426") == "disabled"


async def test_wrong_pin_locks_out_after_the_limit_and_the_cooldown_doubles() -> None:
    clock = FakeClock(BASE)
    store, _ = make_store(clock, max_attempts=3, cooldown_seconds=60)
    await store.lock()
    for _ in range(2):
        assert await store.unlock("0000") == "bad-pin"
    assert store.cooldown_remaining() == 0
    assert await store.unlock("0000") == "bad-pin"  # third strike
    assert store.cooldown_remaining() == 60
    assert await store.unlock("8426") == "locked-out"  # right pin, still barred

    clock.advance(61)
    assert store.cooldown_remaining() == 0
    for _ in range(3):
        await store.unlock("0000")
    assert store.cooldown_remaining() == 120  # doubled


async def test_undo_only_inside_the_grace_window() -> None:
    clock = FakeClock(BASE)
    store, _ = make_store(clock, undo_grace_seconds=8)
    await store.lock()
    clock.advance(5)
    assert await store.undo() is True
    assert store.locked is False

    await store.lock()
    clock.advance(20)
    assert await store.undo() is False
    assert store.locked is True


async def test_state_reloads_from_the_file(tmp_path) -> None:
    path = tmp_path / "privacy.json"
    first, _ = make_store(FakeClock(BASE), path=path)
    await first.lock()
    reloaded = PrivacyStore(clock=FakeClock(BASE), path=path, pin="8426")
    assert reloaded.locked is True
    assert reloaded.state().since == BASE


def test_a_corrupt_file_loads_unlocked(tmp_path) -> None:
    path = tmp_path / "privacy.json"
    path.write_text("{ not json", encoding="utf-8")
    store = PrivacyStore(clock=FakeClock(BASE), path=path, pin="8426")
    assert store.locked is False


# -- endpoints ----------------------------------------------------------------


def test_get_lock_unlock_flow(client: TestClient) -> None:
    assert client.get("/api/privacy").json() == {"locked": False, "since": None, "available": True}

    locked = client.post("/api/privacy/lock")
    assert locked.status_code == 200
    assert locked.json()["locked"] is True
    assert client.get("/api/privacy").json()["locked"] is True

    assert client.post("/api/privacy/unlock", json={"pin": "0000"}).status_code == 401
    ok = client.post("/api/privacy/unlock", json={"pin": "8426"})
    assert ok.status_code == 200
    assert ok.json()["locked"] is False


def test_lock_409s_without_a_configured_pin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_PRIVACY_MODE_PIN", "")
    get_settings.cache_clear()
    local = TestClient(app)
    assert local.get("/api/privacy").json()["available"] is False
    assert local.post("/api/privacy/lock").status_code == 409
    assert local.post("/api/privacy/unlock", json={"pin": "8426"}).status_code == 409


def test_repeated_wrong_pins_get_a_429_with_retry_after(client: TestClient) -> None:
    client.post("/api/privacy/lock")
    for _ in range(5):
        assert client.post("/api/privacy/unlock", json={"pin": "0000"}).status_code == 401
    barred = client.post("/api/privacy/unlock", json={"pin": "0000"})
    assert barred.status_code == 429
    assert int(barred.headers["retry-after"]) > 0
    # The right PIN is refused too while the cooldown is active.
    assert client.post("/api/privacy/unlock", json={"pin": "8426"}).status_code == 429


def test_grace_undo_endpoint(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    client.post("/api/privacy/lock")
    undone = client.post("/api/privacy/unlock/grace")
    assert undone.status_code == 200
    assert undone.json()["locked"] is False

    # Past the window: 410 Gone. Drive the singleton store off a fake clock so the
    # lock stamp and the undo check cannot land on the same coarse OS tick.
    monkeypatch.setenv("MISSION_CONTROL_PRIVACY_UNDO_GRACE_SECONDS", "0")
    get_settings.cache_clear()
    from app.privacy import get_privacy_store, reset_privacy_store

    reset_privacy_store()
    local = TestClient(app)
    clock = FakeClock(BASE)
    get_privacy_store()._clock = clock
    local.post("/api/privacy/lock")
    clock.advance(1)
    assert local.post("/api/privacy/unlock/grace").status_code == 410


def test_privacy_endpoints_are_gated_to_the_local_network() -> None:
    get_settings.cache_clear()
    local_only = TestClient(app)
    assert local_only.get("/api/privacy").status_code == 403
    assert local_only.post("/api/privacy/lock").status_code == 403


# -- the read-only gate -----------------------------------------------------


def test_mutations_are_423_while_locked_reads_still_work(client: TestClient) -> None:
    client.post("/api/privacy/lock")

    assert client.post("/api/timers", json={"duration_seconds": 300}).status_code == 423
    assert client.post("/api/lists/grocery/items", json={"name": "milk"}).status_code == 423
    assert client.post("/api/lists/grocery/clear", json={"scope": "all"}).status_code == 423

    # Reads are untouched — the kiosk still needs them to render the redacted view.
    assert client.get("/api/timers").status_code == 200
    assert client.get("/api/lists").status_code == 200
    assert client.get("/api/calendar").status_code == 200

    client.post("/api/privacy/unlock", json={"pin": "8426"})
    assert client.post("/api/lists/grocery/items", json={"name": "milk"}).status_code == 200


def test_a_firing_alarm_can_still_be_dismissed_while_locked(client: TestClient) -> None:
    from app.models import TimerState
    from app.timers import get_timer_store

    created = client.post("/api/timers", json={"duration_seconds": 300, "label": "pasta"})
    timer_id = created.json()["timer"]["id"]
    # Force it into the firing state without waiting on the scheduler.
    get_timer_store().list_timers()[0].state = TimerState.fired

    client.post("/api/privacy/lock")
    # A running timer could not be cancelled — but a *fired* one can be silenced.
    assert client.delete(f"/api/timers/{timer_id}").status_code == 204


def test_voice_sessions_are_not_gated_by_privacy_mode(client: TestClient) -> None:
    """Resolution 5: voice stays reachable while locked; it refuses individual
    commands on the kiosk instead of the session being blocked."""
    client.post("/api/privacy/lock")
    # Voice is off in tests, so this 409s — the point is it is *not* 423.
    assert client.post("/api/voice/token").status_code != 423


# -- websocket ------------------------------------------------------------


def test_websocket_sends_privacy_state_on_connect(client: TestClient) -> None:
    client.post("/api/privacy/lock")
    with client.websocket_connect("/api/ws") as ws:
        assert ws.receive_json()["type"] == "connected"
        assert ws.receive_json()["type"] == "timers"
        assert ws.receive_json()["type"] == "lists"
        privacy = ws.receive_json()
        assert privacy["type"] == "privacy"
        assert privacy["privacy"]["locked"] is True
        assert ws.receive_json()["type"] == "display"


def test_websocket_broadcasts_on_lock_and_unlock(client: TestClient) -> None:
    with client.websocket_connect("/api/ws") as ws:
        for _ in range(5):  # connected, timers, lists, privacy, display
            ws.receive_json()
        client.post("/api/privacy/lock")
        pushed = ws.receive_json()
        assert pushed["type"] == "privacy-locked"
        assert pushed["privacy"]["locked"] is True
