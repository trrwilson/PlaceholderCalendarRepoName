"""Backend-owned, in-memory timer store + scheduler.

The backend is the single source of truth for timers: it holds them in process
memory, schedules the fire, and pushes every change to the kiosk over ``/api/ws``.
**A backend restart clears active timers** — an accepted limitation (see
``docs/timer-plan.md``). No datastore.

For this task there is **one active timer at a time**. The store keys timers by
id (a ``dict``) so moving to *N* concurrent timers is a later config change, not a
rewrite; creating a timer while one is ``running`` or ``fired`` silently
**replaces** it, and every mutation result / broadcast carries the ``replaced``
timer so surfaces can announce it.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from uuid import uuid4

from app.models import (
    TIMER_MAX_SECONDS,
    TIMER_MIN_SECONDS,
    ApplicationMessage,
    Timer,
    TimerCreateRequest,
    TimerExtendRequest,
    TimerMutationResult,
    TimerState,
)
from app.realtime import connections

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
Broadcast = Callable[[ApplicationMessage], Awaitable[None]]


class TimerError(ValueError):
    """An invalid timer request (duration out of range, cap exceeded)."""


async def _noop_broadcast(_message: ApplicationMessage) -> None:
    return None


class TimerStore:
    def __init__(
        self,
        *,
        clock: Clock | None = None,
        broadcast: Broadcast | None = None,
        max_seconds: int = TIMER_MAX_SECONDS,
    ) -> None:
        self._clock: Clock = clock or datetime.now
        self._broadcast: Broadcast = broadcast or _noop_broadcast
        self._max_seconds = max_seconds
        self._timers: dict[str, Timer] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    # -- reads ---------------------------------------------------------------

    def list_timers(self) -> list[Timer]:
        return list(self._timers.values())

    def get(self, timer_id: str) -> Timer | None:
        return self._timers.get(timer_id)

    # -- mutations ---------------------------------------------------------------

    async def create(self, request: TimerCreateRequest) -> TimerMutationResult:
        if not TIMER_MIN_SECONDS <= request.duration_seconds <= self._max_seconds:
            raise TimerError(self._cap_message())
        now = self._clock()
        replaced = self._retire_active()
        timer = Timer(
            id=uuid4().hex,
            label=(request.label or None),
            created_at=now,
            fires_at=now + timedelta(seconds=request.duration_seconds),
            duration_seconds=request.duration_seconds,
            state=TimerState.running,
        )
        self._timers[timer.id] = timer
        self._arm(timer)
        await self._emit(
            "timer-started",
            self._describe("Started", timer, replaced),
            timer=timer,
            replaced=replaced,
        )
        return TimerMutationResult(timer=timer, replaced=replaced)

    async def extend(self, timer_id: str, request: TimerExtendRequest) -> Timer:
        current = self._timers.get(timer_id)
        if current is None:
            raise KeyError(timer_id)
        now = self._clock()
        # Snoozing a fired alarm extends from *now*; extending a running timer
        # from its current fires_at. Either way we rebase created_at to now so
        # ``duration_seconds == fires_at - created_at`` stays exact and within the
        # cap (an old created_at could otherwise push duration past the ceiling).
        base = current.fires_at if current.state == TimerState.running else now
        fires_at = base + timedelta(seconds=request.add_seconds)
        lookahead = round((fires_at - now).total_seconds())
        if lookahead > self._max_seconds:
            raise TimerError(self._cap_message())
        if lookahead < TIMER_MIN_SECONDS:
            raise TimerError(self._cap_message())
        extended = Timer(
            id=current.id,
            label=current.label,
            created_at=now,
            fires_at=fires_at,
            duration_seconds=lookahead,
            state=TimerState.running,
        )
        self._timers[extended.id] = extended
        self._arm(extended)
        await self._emit(
            "timer-extended", self._describe("Extended", extended, None), timer=extended
        )
        return extended

    async def cancel(self, timer_id: str) -> Timer:
        current = self._timers.get(timer_id)
        if current is None:
            raise KeyError(timer_id)
        self._disarm(timer_id)
        dismissed = current.model_copy(update={"state": TimerState.dismissed})
        del self._timers[timer_id]
        await self._emit(
            "timer-dismissed", self._describe("Dismissed", dismissed, None), timer=dismissed
        )
        return dismissed

    def clear(self) -> None:
        """Drop every timer and cancel its fire without a broadcast — for
        lifespan shutdown / tests."""
        for timer_id in list(self._tasks):
            self._disarm(timer_id)
        self._timers.clear()

    # -- firing ---------------------------------------------------------------

    def _arm(self, timer: Timer) -> None:
        self._disarm(timer.id)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Imported / exercised without an event loop (some tests). The request
            # handler that created the timer runs on a loop; this only skips the
            # background sleep, not the timer itself.
            return
        delay = max(0.0, (timer.fires_at - self._clock()).total_seconds())
        self._tasks[timer.id] = loop.create_task(self._sleep_then_fire(timer.id, delay))

    def _disarm(self, timer_id: str) -> None:
        task = self._tasks.pop(timer_id, None)
        if task is not None and not task.done():
            task.cancel()

    async def _sleep_then_fire(self, timer_id: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return
        await self.fire(timer_id)

    async def fire(self, timer_id: str) -> None:
        """Transition a running timer to ``fired`` and broadcast. Idempotent."""
        current = self._timers.get(timer_id)
        if current is None or current.state != TimerState.running:
            return
        self._tasks.pop(timer_id, None)
        fired = current.model_copy(update={"state": TimerState.fired})
        self._timers[timer_id] = fired
        await self._emit("timer-fired", self._alarm_message(fired), timer=fired)

    # -- helpers ---------------------------------------------------------------

    def _retire_active(self) -> Timer | None:
        if not self._timers:
            return None
        # There is at most one for this task; take whichever is present.
        timer_id, timer = next(iter(self._timers.items()))
        self._disarm(timer_id)
        del self._timers[timer_id]
        return timer.model_copy(update={"state": TimerState.dismissed})

    async def _emit(
        self,
        message_type: str,
        message: str,
        *,
        timer: Timer | None = None,
        replaced: Timer | None = None,
    ) -> None:
        await self._broadcast(
            ApplicationMessage(
                type=message_type,
                message=message,
                timers=self.list_timers(),
                timer=timer,
                replaced=replaced,
            )
        )

    def _cap_message(self) -> str:
        hours = self._max_seconds // 3600
        spelled = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six"}.get(
            hours, str(hours)
        )
        return f"Timers can be at most {spelled} hours."

    @staticmethod
    def _label(timer: Timer | None) -> str:
        if timer is None:
            return "timer"
        return f"{timer.label} timer" if timer.label else "timer"

    def _describe(self, verb: str, timer: Timer, replaced: Timer | None) -> str:
        minutes = max(1, round(timer.duration_seconds / 60))
        base = f"{verb} a {minutes}-minute {self._label(timer)}"
        if replaced is not None:
            base = f"{base} (replaced your {self._label(replaced)})"
        return base

    @staticmethod
    def _alarm_message(timer: Timer) -> str:
        return f"Timer finished: {timer.label}" if timer.label else "Timer finished"


# -- process-wide singleton ---------------------------------------------------

_store: TimerStore | None = None


def get_timer_store() -> TimerStore:
    global _store
    if _store is None:
        from app.config import get_settings

        _store = TimerStore(
            broadcast=connections.broadcast,
            max_seconds=get_settings().timer_max_seconds,
        )
    return _store


def reset_timer_store() -> None:
    """Drop the singleton and cancel its scheduled fires (tests / a fresh process)."""
    global _store
    if _store is not None:
        _store.clear()
    _store = None
