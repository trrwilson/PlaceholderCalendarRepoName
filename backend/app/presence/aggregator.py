"""``PresenceAggregator`` — the pure, testable policy object at the heart of
the presence contract (``docs/presence-module-plan.md``).

One instance, many independently-tracked scopes (today only ``kiosk``; a future
``zone:<name>`` source drops in without changing this class). Pure and
clock-injected, same house style as ``MockCalendarProvider``'s injected
``today`` and ``DisplayStore`` — no I/O, no camera, no network, so it is safe
to construct under pytest and on any host regardless of ``host_local_camera``.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import datetime, timedelta

from app.models import PresenceScope, PresenceSignal, PresenceSignalKind, PresenceState

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
OnChange = Callable[[PresenceState], None]


class PresenceAggregator:
    """Applies each observed :class:`PresenceSignal` to its scope's running
    :class:`PresenceState` and calls ``on_change`` when the *meaningful* part
    of that state actually moves.

    Hysteresis (``docs/camera-support-plan.md`` "Presence policy"): a single
    ``presence=False`` observation does not clear ``present`` — it must stay
    false for ``inactivity_timeout_seconds`` of continuous absence first. Any
    ``activity`` pulse, a ``presence=True`` observation, or a ``zone_entry``
    clears/sets it immediately. ``motion`` is deliberately weaker than either:
    per the envelope's own definition (a camera's raw motion event, before/
    without person detection) it never claims a standing presence — it only
    advances ``last_signal_at``, so a source that cannot yet confirm a person
    (this MVP's local-camera detector) does not silently promise more than it
    knows. A future real presence/person detector emits ``presence`` instead
    and gets the full hysteresis treatment.

    ``observe()`` is called from more than one thread in practice — a source's
    own background thread (the local camera) and a FastAPI sync request
    handler (``POST /api/presence/activity`` runs on Starlette's threadpool,
    not the event loop) — so its read-modify-write over ``_states`` is guarded
    by a lock.

    ``on_signal`` is distinct from ``on_change``: it fires on *every*
    ``observe()`` call for the scope, regardless of whether ``present`` (or
    anything else) actually moved. This is what a policy driven purely by
    "was there recent activity at all" needs — the display-dimming policy
    (``app/presence/display_policy.py``) subscribes here rather than to
    ``on_change`` precisely because this MVP's `motion` signals never flip
    ``present`` and so would never reach ``on_change``.
    """

    def __init__(
        self,
        *,
        now: Clock = datetime.now,
        on_change: OnChange | None = None,
        on_signal: OnChange | None = None,
        inactivity_timeout_seconds: int = 900,
    ) -> None:
        self._now = now
        self._on_change = on_change or (lambda _state: None)
        self._on_signal = on_signal or (lambda _state: None)
        self._timeout = timedelta(seconds=inactivity_timeout_seconds)
        self._states: dict[PresenceScope, PresenceState] = {}
        # First moment each scope has seen unbroken `presence=False` — cleared
        # the instant that scope sees activity / presence=True / zone_entry.
        self._absent_since: dict[PresenceScope, datetime] = {}
        self._lock = threading.Lock()

    def state(self, scope: PresenceScope) -> PresenceState:
        return self._states.get(scope) or PresenceState(scope=scope, present=False)

    def observe(self, signal: PresenceSignal) -> None:
        scope = signal.scope
        with self._lock:
            current = self.state(scope)
            present = current.present
            prev_last_activity_at = current.last_activity_at
            last_activity_at = prev_last_activity_at

            if signal.kind is PresenceSignalKind.activity:
                present = True
                last_activity_at = signal.observed_at
                self._absent_since.pop(scope, None)
            elif signal.kind is PresenceSignalKind.presence:
                if signal.value:
                    present = True
                    self._absent_since.pop(scope, None)
                else:
                    started = self._absent_since.setdefault(scope, signal.observed_at)
                    if signal.observed_at - started >= self._timeout:
                        present = False
            elif signal.kind is PresenceSignalKind.zone_entry:
                present = True
                self._absent_since.pop(scope, None)
            elif signal.kind is PresenceSignalKind.zone_exit:
                present = False
            # kind == motion: no effect on `present` or `last_activity_at` — see
            # the class docstring. `last_signal_at` still advances below, so a
            # human watching GET /api/presence sees it move on every motion
            # event even though `present` itself is untouched.

            new_state = PresenceState(
                scope=scope,
                present=present,
                last_signal_at=signal.observed_at,
                last_activity_at=last_activity_at,
            )
            self._states[scope] = new_state

            # "Don't re-issue identical commands" (the same rule DisplayStore
            # applies to brightness levels): compare only the fields a
            # downstream policy would act on, not `last_signal_at` — otherwise
            # every motion tick would look like a change and on_change would
            # fire constantly.
            state_changed = (
                new_state.present != current.present
                or new_state.last_activity_at != prev_last_activity_at
            )

        # Call callbacks outside the lock: they run code this class doesn't
        # control, and holding the lock across them risks a deadlock if that
        # code ever calls back into this aggregator.
        if state_changed:
            logger.info(
                "presence: %s state -> present=%s last_activity_at=%s",
                scope.id,
                new_state.present,
                new_state.last_activity_at,
            )
            self._on_change(new_state)
        self._on_signal(new_state)
