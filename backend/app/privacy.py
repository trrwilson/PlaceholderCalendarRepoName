"""Household-global privacy mode: redact-the-specifics + a read-only lock.

One flag drives both effects. It is entered from the kiosk with no secret (the
safe direction) and left only by entering the configured PIN on the on-screen
keypad. The state is persisted to one git-ignored JSON file so a power-cycle does
not defeat the lock; the wrong-PIN lockout counters are process memory only.

Like ``TimerStore`` / ``ListStore`` this never imports the WebSocket layer — the
broadcast callback is injected — so it is unit-testable without a socket. See
``docs/privacy-mode-plan.md``.

**This is a social / glance barrier, not a security control.** Someone with
sustained physical access to the kiosk host can always get past it.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import tempfile
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from app.models import ApplicationMessage, PrivacyState

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
Broadcast = Callable[[ApplicationMessage], Awaitable[None]]

UnlockOutcome = Literal["ok", "bad-pin", "locked-out", "disabled"]

_COOLDOWN_CAP_SECONDS = 3_600


async def _noop_broadcast(_message: ApplicationMessage) -> None:
    return None


class PrivacyStore:
    def __init__(
        self,
        *,
        pin: str = "",
        clock: Clock | None = None,
        broadcast: Broadcast | None = None,
        path: str | os.PathLike[str] | None = None,
        max_attempts: int = 5,
        cooldown_seconds: int = 60,
        undo_grace_seconds: int = 8,
    ) -> None:
        self._pin = pin.strip()
        self._clock: Clock = clock or datetime.now
        self._broadcast: Broadcast = broadcast or _noop_broadcast
        self._path = Path(path) if path else None
        self._max_attempts = max(1, max_attempts)
        self._base_cooldown = max(1, cooldown_seconds)
        self._undo_grace = max(0, undo_grace_seconds)

        self._locked = False
        self._since: datetime | None = None
        # Wrong-PIN bookkeeping — never persisted.
        self._failed = 0
        self._lockouts = 0
        self._locked_out_until: datetime | None = None
        self._load()

    # -- reads -------------------------------------------------------------

    @property
    def locked(self) -> bool:
        return self._locked

    @property
    def available(self) -> bool:
        return bool(self._pin)

    def state(self) -> PrivacyState:
        return PrivacyState(locked=self._locked, since=self._since, available=self.available)

    def cooldown_remaining(self) -> int:
        if self._locked_out_until is None:
            return 0
        return max(0, int((self._locked_out_until - self._clock()).total_seconds()))

    def in_undo_window(self) -> bool:
        if not self._locked or self._since is None:
            return False
        return self._clock() - self._since <= timedelta(seconds=self._undo_grace)

    # -- mutations -------------------------------------------------------------

    async def lock(self) -> PrivacyState:
        """Enter privacy mode. Idempotent. Caller has already checked
        :pyattr:`available`."""
        if not self._locked:
            self._locked = True
            self._since = self._clock()
            self._persist()
            await self._emit("privacy-locked", "Privacy mode on")
        return self.state()

    async def unlock(self, pin: str) -> UnlockOutcome:
        if not self._pin:
            return "disabled"
        if self.cooldown_remaining() > 0:
            return "locked-out"
        if secrets.compare_digest(pin.strip(), self._pin):
            self._failed = 0
            self._lockouts = 0
            self._locked_out_until = None
            if self._locked:
                self._locked = False
                self._since = None
                self._persist()
                await self._emit("privacy-unlocked", "Privacy mode off")
            return "ok"
        self._failed += 1
        if self._failed >= self._max_attempts:
            self._lockouts += 1
            cooldown = min(self._base_cooldown * (2 ** (self._lockouts - 1)), _COOLDOWN_CAP_SECONDS)
            self._locked_out_until = self._clock() + timedelta(seconds=cooldown)
            self._failed = 0
        return "bad-pin"

    async def undo(self) -> bool:
        """Leave privacy mode with no PIN — only within the grace window right
        after entry (an accidental / prank toggle)."""
        if not self.in_undo_window():
            return False
        self._locked = False
        self._since = None
        self._persist()
        await self._emit("privacy-unlocked", "Privacy mode off")
        return True

    async def clear_for_tests(self) -> None:
        self._locked = False
        self._since = None
        self._failed = 0
        self._lockouts = 0
        self._locked_out_until = None
        self._persist()

    # -- helpers -------------------------------------------------------------

    async def _emit(self, message_type: str, message: str) -> None:
        await self._broadcast(
            ApplicationMessage(type=message_type, message=message, privacy=self.state())
        )

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            self._locked = bool(raw.get("locked", False))
            since = raw.get("since")
            self._since = datetime.fromisoformat(since) if since else None
        except (OSError, ValueError, TypeError) as exc:
            logger.warning(
                "privacy state file %s unreadable (%s) — starting unlocked", self._path, exc
            )
            self._locked = False
            self._since = None

    def _persist(self) -> None:
        if self._path is None:
            return
        payload = {
            "locked": self._locked,
            "since": self._since.isoformat() if self._since else None,
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=".privacy-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
            os.replace(tmp, self._path)
        except OSError as exc:  # noqa: BLE001 - persistence is best-effort
            logger.warning("could not persist privacy state to %s: %s", self._path, exc)


# -- process-wide singleton ---------------------------------------------------

_store: PrivacyStore | None = None


def get_privacy_store() -> PrivacyStore:
    global _store
    if _store is None:
        from app.config import get_settings
        from app.realtime import connections

        settings = get_settings()
        _store = PrivacyStore(
            pin=settings.privacy_mode_pin,
            broadcast=connections.broadcast,
            path=settings.privacy_state_file or None,
            max_attempts=settings.privacy_unlock_max_attempts,
            cooldown_seconds=settings.privacy_unlock_cooldown_seconds,
            undo_grace_seconds=settings.privacy_undo_grace_seconds,
        )
    return _store


def reset_privacy_store() -> None:
    """Drop the singleton (tests / a fresh process)."""
    global _store
    _store = None
