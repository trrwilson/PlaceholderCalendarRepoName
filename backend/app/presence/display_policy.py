"""Presence-driven ambient display dimming — a basic first slice of the
inactivity policy ``docs/display-dimming-plan.md`` and
``docs/presence-module-plan.md`` both describe as future work ("Kiosk-scope
output: Feeds the inactivity/display policy in-process").

Deliberately simpler than that fuller design: it reacts to *any* observed
kiosk-scope :class:`~app.models.PresenceSignal` (via
:class:`~app.presence.aggregator.PresenceAggregator`'s ``on_signal`` hook —
not ``on_change``, since this MVP's ``motion`` signals never flip ``present``)
rather than to touch/voice/timer activity pulses, and it restores to a fixed
configured level rather than "whatever the panel was showing before". It
reuses the exact brightness primitive the "night mode" voice command uses
(:class:`~app.display.DisplayStore`), layered underneath whatever night-mode
choice is standing via :meth:`~app.display.DisplayStore.set_ambient_brightness`
so toggling night mode while dimmed is still respected on the next restore.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from app.display import DisplayStore
from app.models import PresenceState

logger = logging.getLogger(__name__)

GetLoop = Callable[[], "asyncio.AbstractEventLoop | None"]


class PresenceDisplayPolicy:
    """Dims the panel after ``dim_timeout_seconds`` with no kiosk-scope
    presence signal; any subsequent signal restores it immediately.

    ``on_signal`` is called synchronously from
    :meth:`PresenceAggregator.observe`, which itself may run on a thread with
    no running event loop (the local camera's background thread, or a sync
    FastAPI request handler on Starlette's threadpool) — so the actual async
    work is always handed to the event loop via ``loop.call_soon_threadsafe``,
    the same bridging ``app/voice/wake_azure.py`` uses for its own
    SDK-callback thread. ``get_loop`` is a callable rather than a captured
    reference because the loop is not running yet when this policy is
    constructed.
    """

    def __init__(
        self,
        *,
        display: DisplayStore,
        get_loop: GetLoop,
        dim_timeout_seconds: float,
        dim_target_pct: int,
        bright_target_pct: int,
    ) -> None:
        self._display = display
        self._get_loop = get_loop
        self._timeout = dim_timeout_seconds
        self._dim_target = dim_target_pct
        self._bright_target = bright_target_pct
        self._dimmed = False
        self._timer_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Kick off the dim countdown. Called once at backend startup — a real
        deployment may sit with no presence signal at all before the first one
        arrives, and the timeout should still elapse in that case. Must be
        called from the event loop thread."""
        self._reset_timer()

    def stop(self) -> None:
        """Cancel any pending timer (backend shutdown / test teardown)."""
        if self._timer_task is not None:
            self._timer_task.cancel()
            self._timer_task = None

    def on_signal(self, _state: PresenceState) -> None:
        loop = self._get_loop()
        if loop is None:
            return
        loop.call_soon_threadsafe(self._handle_signal)

    def _handle_signal(self) -> None:
        # Runs on the event loop thread (scheduled via call_soon_threadsafe,
        # which is safe to call from any thread, including this one).
        self._reset_timer()
        if self._dimmed:
            self._dimmed = False
            asyncio.ensure_future(self._restore())

    def _reset_timer(self) -> None:
        if self._timer_task is not None:
            self._timer_task.cancel()
        self._timer_task = asyncio.ensure_future(self._sleep_then_dim())

    async def _sleep_then_dim(self) -> None:
        try:
            await asyncio.sleep(self._timeout)
        except asyncio.CancelledError:
            return
        self._dimmed = True
        logger.info("presence: display idle-dimmed to %s%%", self._dim_target)
        await self._display.set_ambient_brightness(self._dim_target)

    async def _restore(self) -> None:
        # Night mode dynamically replaces the upper (bright) value: restored
        # presence while night mode is on should land at night's own level,
        # not the fixed daytime target.
        target = self._display.night_level() if self._display.night_mode else self._bright_target
        logger.info("presence: display restored to %s%% on presence signal", target)
        await self._display.set_ambient_brightness(target)
