"""Persisted opt-in for non-primary Outlook calendars.

Every connected Outlook account's *default* calendar is always shown — that is
the "one calendar per household member" model the kiosk was built around. An
account can also carry other calendars (a shared team calendar, the
auto-added "Holidays" calendar, …); the providers always list these
(``HouseholdCalendar.is_primary=False``) so the people flyout can offer them,
but only fetch their events once a household member has explicitly turned one
on — otherwise every extra calendar on every linked account would show up
uninvited, and get polled for events nobody asked to see.

Same "one JSON file, no datastore" shape as ``app/privacy.py``: a git-ignored
file, atomic replace, no broadcast — the kiosk picks up a toggle on its next
``GET /api/calendar`` poll, the same way it already picks up a newly linked
account.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)


class SecondaryCalendarStore:
    def __init__(self, *, path: str | os.PathLike[str] | None = None) -> None:
        self._path = Path(path) if path else None
        self._enabled: set[str] = set()
        self._load()

    def is_enabled(self, calendar_id: str) -> bool:
        return calendar_id in self._enabled

    def set_enabled(self, calendar_id: str, enabled: bool) -> None:
        if enabled == (calendar_id in self._enabled):
            return
        if enabled:
            self._enabled.add(calendar_id)
        else:
            self._enabled.discard(calendar_id)
        self._persist()

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            self._enabled = {str(calendar_id) for calendar_id in raw.get("enabled", [])}
        except (OSError, ValueError, TypeError) as exc:
            logger.warning(
                "secondary calendar state file %s unreadable (%s) — starting empty",
                self._path,
                exc,
            )
            self._enabled = set()

    def _persist(self) -> None:
        if self._path is None:
            return
        payload = {"enabled": sorted(self._enabled)}
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(
                dir=self._path.parent, prefix=".secondary-calendars-", suffix=".tmp"
            )
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
            os.replace(tmp, self._path)
        except OSError as exc:  # noqa: BLE001 - persistence is best-effort
            logger.warning("could not persist secondary calendar state to %s: %s", self._path, exc)


# -- process-wide singleton ---------------------------------------------------

_store: SecondaryCalendarStore | None = None


def get_secondary_calendar_store() -> SecondaryCalendarStore:
    global _store
    if _store is None:
        from app.config import get_settings

        settings = get_settings()
        _store = SecondaryCalendarStore(path=settings.calendar_secondary_state_file or None)
    return _store


def reset_secondary_calendar_store() -> None:
    """Drop the singleton (tests / a fresh process)."""
    global _store
    _store = None
