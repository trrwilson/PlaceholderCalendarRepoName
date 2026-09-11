import asyncio
from datetime import datetime

from app.display import DisplayStore
from app.models import PresenceScope
from app.presence.display_policy import PresenceDisplayPolicy

KIOSK = PresenceScope(kind="kiosk", id="kiosk")


def _presence_state(present: bool = False):
    from app.models import PresenceState

    return PresenceState(scope=KIOSK, present=present, last_signal_at=datetime.now())


def make_policy(store: DisplayStore, **kw) -> PresenceDisplayPolicy:
    loop = asyncio.get_running_loop()
    defaults = dict(dim_timeout_seconds=0.03, dim_target_pct=0, bright_target_pct=80)
    defaults.update(kw)
    return PresenceDisplayPolicy(display=store, get_loop=lambda: loop, **defaults)


async def test_dims_after_the_timeout_with_no_signal() -> None:
    store = DisplayStore()
    policy = make_policy(store)
    policy.start()
    await asyncio.sleep(0.08)
    assert store.state().brightness == 0
    policy.stop()


async def test_a_signal_before_the_timeout_prevents_the_dim() -> None:
    store = DisplayStore()
    policy = make_policy(store)
    policy.start()
    await asyncio.sleep(0.015)
    policy.on_signal(_presence_state())
    await asyncio.sleep(0.015)  # 0.03s total elapsed, but the timer reset at 0.015s
    assert store.state().brightness == 100  # still not dimmed
    policy.stop()


async def test_a_signal_after_dimming_restores_the_bright_target() -> None:
    store = DisplayStore()
    policy = make_policy(store)
    policy.start()
    await asyncio.sleep(0.08)
    assert store.state().brightness == 0

    policy.on_signal(_presence_state())
    await asyncio.sleep(0.02)  # let call_soon_threadsafe + the restore task run
    assert store.state().brightness == 80
    policy.stop()


async def test_restore_uses_night_level_when_night_mode_is_on() -> None:
    store = DisplayStore(default_brightness=100)
    await store.set_night_mode(True)  # reference=100, dims to the default night pct (10%)
    assert store.state().night_mode is True

    policy = make_policy(store)
    policy.start()
    await asyncio.sleep(0.08)
    assert store.state().brightness == 0
    assert store.state().night_mode is True  # untouched by the ambient dim

    policy.on_signal(_presence_state())
    await asyncio.sleep(0.02)
    assert store.state().brightness == 10  # night's level, not the fixed 80 target
    policy.stop()


async def test_stop_cancels_a_pending_dim() -> None:
    store = DisplayStore()
    policy = make_policy(store)
    policy.start()
    policy.stop()
    await asyncio.sleep(0.08)
    assert store.state().brightness == 100  # never dimmed


def test_on_signal_without_a_bound_loop_is_a_harmless_noop() -> None:
    store = DisplayStore()
    policy = PresenceDisplayPolicy(
        display=store,
        get_loop=lambda: None,
        dim_timeout_seconds=0.03,
        dim_target_pct=0,
        bright_target_pct=80,
    )
    policy.on_signal(_presence_state())  # must not raise
    assert store.state().brightness == 100
