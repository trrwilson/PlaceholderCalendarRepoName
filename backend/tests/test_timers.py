from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.models import (
    ApplicationMessage,
    Timer,
    TimerCreateRequest,
    TimerExtendRequest,
    TimerState,
)
from app.timers import TimerError, TimerStore

BASE = datetime(2026, 9, 6, 8, 0, 0)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    from app.config import get_settings

    get_settings.cache_clear()
    return TestClient(app)


# -- model -----------------------------------------------------------------------


def test_timer_model_requires_end_after_start() -> None:
    with pytest.raises(ValidationError):
        Timer(
            id="x",
            created_at=BASE,
            fires_at=BASE,
            duration_seconds=60,
        )


@pytest.mark.parametrize("seconds", [0, 4, 21_601])
def test_timer_model_rejects_out_of_range_duration(seconds: int) -> None:
    with pytest.raises(ValidationError):
        Timer(
            id="x",
            created_at=BASE,
            fires_at=BASE + timedelta(seconds=max(seconds, 1)),
            duration_seconds=seconds,
        )


def test_timer_model_accepts_the_six_hour_boundary() -> None:
    timer = Timer(
        id="x",
        created_at=BASE,
        fires_at=BASE + timedelta(seconds=21_600),
        duration_seconds=21_600,
    )
    assert timer.state is TimerState.running


def test_timer_model_rejects_inconsistent_fires_at() -> None:
    with pytest.raises(ValidationError):
        Timer(
            id="x",
            created_at=BASE,
            fires_at=BASE + timedelta(seconds=120),
            duration_seconds=60,
        )


# -- store ---------------------------------------------------------------------


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def make_store(clock: FakeClock) -> tuple[TimerStore, list[ApplicationMessage]]:
    sent: list[ApplicationMessage] = []

    async def broadcast(message: ApplicationMessage) -> None:
        sent.append(message)

    return TimerStore(clock=clock, broadcast=broadcast), sent


async def test_create_broadcasts_and_lists_one_timer() -> None:
    clock = FakeClock(BASE)
    store, sent = make_store(clock)

    result = await store.create(TimerCreateRequest(duration_seconds=600, label="pasta"))

    assert result.replaced is None
    assert result.timer.fires_at == BASE + timedelta(seconds=600)
    assert [t.id for t in store.list_timers()] == [result.timer.id]
    assert sent[-1].type == "timer-started"
    assert sent[-1].timers[0].id == result.timer.id


async def test_create_replaces_the_previous_timer_and_names_it() -> None:
    clock = FakeClock(BASE)
    store, sent = make_store(clock)

    first = await store.create(TimerCreateRequest(duration_seconds=600, label="pasta"))
    second = await store.create(TimerCreateRequest(duration_seconds=300, label="tea"))

    assert second.replaced is not None
    assert second.replaced.id == first.timer.id
    assert second.replaced.state is TimerState.dismissed
    assert len(store.list_timers()) == 1
    assert "pasta" in sent[-1].message


async def test_create_rejects_beyond_a_lowered_cap() -> None:
    sent: list[ApplicationMessage] = []

    async def broadcast(message: ApplicationMessage) -> None:
        sent.append(message)

    store = TimerStore(clock=FakeClock(BASE), broadcast=broadcast, max_seconds=120)
    with pytest.raises(TimerError):
        await store.create(TimerCreateRequest(duration_seconds=300))


async def test_extend_rearms_and_holds_the_cap() -> None:
    clock = FakeClock(BASE)
    store, sent = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600))

    clock.advance(60)
    extended = await store.extend(created.timer.id, TimerExtendRequest(add_seconds=300))
    assert extended.fires_at == BASE + timedelta(seconds=900)
    assert sent[-1].type == "timer-extended"

    clock.advance(0)
    with pytest.raises(TimerError):
        await store.extend(extended.id, TimerExtendRequest(add_seconds=21_600))


async def test_extend_unknown_timer_raises_keyerror() -> None:
    store, _ = make_store(FakeClock(BASE))
    with pytest.raises(KeyError):
        await store.extend("nope", TimerExtendRequest(add_seconds=60))


async def test_cancel_on_empty_store_raises_keyerror() -> None:
    store, _ = make_store(FakeClock(BASE))
    with pytest.raises(KeyError):
        await store.cancel("nope")


async def test_fire_marks_fired_and_broadcasts() -> None:
    clock = FakeClock(BASE)
    store, sent = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600, label="pasta"))

    await store.fire(created.timer.id)

    assert store.get(created.timer.id).state is TimerState.fired
    assert sent[-1].type == "timer-fired"
    assert sent[-1].timer.state is TimerState.fired
    # Idempotent — a second fire is a no-op.
    await store.fire(created.timer.id)
    assert sent[-1].type == "timer-fired"
    assert len([m for m in sent if m.type == "timer-fired"]) == 1


async def test_snoozing_a_fired_timer_rebases_from_now() -> None:
    clock = FakeClock(BASE)
    store, _ = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600))
    await store.fire(created.timer.id)

    clock.advance(30)
    snoozed = await store.extend(created.timer.id, TimerExtendRequest(add_seconds=300))
    assert snoozed.state is TimerState.running
    assert snoozed.fires_at == clock.now + timedelta(seconds=300)


async def test_pause_freezes_the_remaining_time_and_resume_continues_it() -> None:
    clock = FakeClock(BASE)
    store, sent = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600, label="pasta"))

    clock.advance(120)
    paused = await store.pause(created.timer.id)
    assert paused.state is TimerState.paused
    assert paused.remaining_seconds == 480
    assert sent[-1].type == "timer-paused"

    # Time passing while paused does not eat into the timer.
    clock.advance(3_600)
    resumed = await store.resume(created.timer.id)
    assert resumed.state is TimerState.running
    assert resumed.remaining_seconds is None
    assert resumed.fires_at == clock.now + timedelta(seconds=480)
    assert resumed.duration_seconds == 600  # original duration preserved
    assert sent[-1].type == "timer-resumed"


async def test_pause_rejects_a_timer_that_is_not_running() -> None:
    clock = FakeClock(BASE)
    store, _ = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600))
    await store.fire(created.timer.id)
    with pytest.raises(TimerError):
        await store.pause(created.timer.id)


async def test_resume_rejects_a_timer_that_is_not_paused() -> None:
    clock = FakeClock(BASE)
    store, _ = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600))
    with pytest.raises(TimerError):
        await store.resume(created.timer.id)


async def test_extending_a_paused_timer_keeps_it_paused() -> None:
    clock = FakeClock(BASE)
    store, _ = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600))
    clock.advance(120)
    await store.pause(created.timer.id)

    extended = await store.extend(created.timer.id, TimerExtendRequest(add_seconds=300))
    assert extended.state is TimerState.paused
    assert extended.remaining_seconds == 780


async def test_restart_resets_to_the_full_duration_from_any_state() -> None:
    clock = FakeClock(BASE)
    store, sent = make_store(clock)
    created = await store.create(TimerCreateRequest(duration_seconds=600, label="pasta"))
    await store.fire(created.timer.id)

    clock.advance(45)
    restarted = await store.restart(created.timer.id)
    assert restarted.state is TimerState.running
    assert restarted.fires_at == clock.now + timedelta(seconds=600)
    assert sent[-1].type == "timer-restarted"


async def test_pause_resume_restart_unknown_timer_raises_keyerror() -> None:
    store, _ = make_store(FakeClock(BASE))
    for op in (store.pause, store.resume, store.restart):
        with pytest.raises(KeyError):
            await op("nope")


# -- endpoints ---------------------------------------------------------------------


def test_post_creates_a_timer(client: TestClient) -> None:
    response = client.post("/api/timers", json={"duration_seconds": 300, "label": "pasta"})
    assert response.status_code == 200
    body = response.json()
    assert body["timer"]["duration_seconds"] == 300
    assert body["replaced"] is None
    assert client.get("/api/timers").json()[0]["label"] == "pasta"


def test_post_rejects_out_of_range(client: TestClient) -> None:
    assert client.post("/api/timers", json={"duration_seconds": 0}).status_code == 422
    assert client.post("/api/timers", json={"duration_seconds": 30_000}).status_code == 422


def test_patch_extends_and_guards_the_cap(client: TestClient) -> None:
    created = client.post("/api/timers", json={"duration_seconds": 300}).json()["timer"]
    ok = client.patch(f"/api/timers/{created['id']}", json={"add_seconds": 120})
    assert ok.status_code == 200

    over = client.patch(f"/api/timers/{created['id']}", json={"add_seconds": 21_600})
    assert over.status_code == 422
    assert "six hours" in over.json()["detail"]


def test_patch_unknown_timer_is_404(client: TestClient) -> None:
    assert client.patch("/api/timers/nope", json={"add_seconds": 60}).status_code == 404


def test_delete_cancels_and_unknown_is_404(client: TestClient) -> None:
    created = client.post("/api/timers", json={"duration_seconds": 300}).json()["timer"]
    assert client.delete(f"/api/timers/{created['id']}").status_code == 204
    assert client.get("/api/timers").json() == []
    assert client.delete("/api/timers/nope").status_code == 404


def test_pause_resume_and_restart_endpoints(client: TestClient) -> None:
    created = client.post("/api/timers", json={"duration_seconds": 600}).json()["timer"]

    paused = client.post(f"/api/timers/{created['id']}/pause")
    assert paused.status_code == 200
    assert paused.json()["state"] == "paused"
    assert paused.json()["remaining_seconds"] is not None

    # Pausing an already-paused timer is a state conflict, not a crash.
    assert client.post(f"/api/timers/{created['id']}/pause").status_code == 409

    resumed = client.post(f"/api/timers/{created['id']}/resume")
    assert resumed.status_code == 200
    assert resumed.json()["state"] == "running"

    assert client.post(f"/api/timers/{created['id']}/resume").status_code == 409

    restarted = client.post(f"/api/timers/{created['id']}/restart")
    assert restarted.status_code == 200
    assert restarted.json()["duration_seconds"] == 600


def test_pause_resume_restart_unknown_timer_is_404(client: TestClient) -> None:
    for op in ("pause", "resume", "restart"):
        assert client.post(f"/api/timers/nope/{op}").status_code == 404


def test_timer_model_rejects_a_paused_state_without_remaining_seconds() -> None:
    with pytest.raises(ValidationError):
        Timer(
            id="x",
            created_at=BASE,
            fires_at=BASE + timedelta(seconds=600),
            duration_seconds=600,
            state=TimerState.paused,
        )


def test_timer_endpoints_are_gated_to_the_local_network() -> None:
    # Default TestClient host is not a private address and remote auth is off.
    from app.config import get_settings

    get_settings.cache_clear()
    local_only = TestClient(app)
    assert local_only.get("/api/timers").status_code == 403
    assert local_only.post("/api/timers", json={"duration_seconds": 300}).status_code == 403


def test_websocket_sends_the_current_timers_on_connect(client: TestClient) -> None:
    client.post("/api/timers", json={"duration_seconds": 300, "label": "pasta"})
    with client.websocket_connect("/api/ws") as ws:
        assert ws.receive_json()["type"] == "connected"
        timers_message = ws.receive_json()
        assert timers_message["type"] == "timers"
        assert timers_message["timers"][0]["label"] == "pasta"


def test_websocket_receives_a_broadcast_when_a_timer_is_created(client: TestClient) -> None:
    with client.websocket_connect("/api/ws") as ws:
        ws.receive_json()  # connected
        ws.receive_json()  # initial (empty) timers
        ws.receive_json()  # initial lists
        ws.receive_json()  # initial privacy
        ws.receive_json()  # initial display
        client.post("/api/timers", json={"duration_seconds": 300, "label": "tea"})
        pushed = ws.receive_json()
        assert pushed["type"] == "timer-started"
        assert pushed["timer"]["label"] == "tea"
