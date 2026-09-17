"""Backend-owned sticky notes for the Home notes pane + JSON persistence.

Durable like the grocery list (a wall appliance that forgets a note on reboot is
broken UX), persisted to one git-ignored JSON file
(``MISSION_CONTROL_NOTES_FILE``), atomic write, reloaded at startup, corrupt file
reseeds empty. Unlike lists/timers, notes are a single-kiosk, single-viewer
surface — no ``/api/ws`` broadcast; the frontend holds its own state and syncs
over plain REST.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from app.models import Note, NoteCreateRequest, NoteUpdateRequest

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]

NOTES_MAX = 30


class NoteError(ValueError):
    """Too many notes already on the board."""


class NoteStore:
    def __init__(
        self,
        *,
        clock: Clock | None = None,
        path: str | os.PathLike[str] | None = None,
        notes_max: int = NOTES_MAX,
    ) -> None:
        self._clock: Clock = clock or datetime.now
        self._path = Path(path) if path is not None else None
        self._max = notes_max
        self._notes: dict[str, Note] = {}
        self._next_z = 1
        self._load()

    # -- reads -----------------------------------------------------------

    def list_all(self) -> list[Note]:
        return sorted(self._notes.values(), key=lambda note: note.z)

    # -- mutations ---------------------------------------------------------

    def create(self, request: NoteCreateRequest) -> Note:
        if len(self._notes) >= self._max:
            raise NoteError(f"at most {self._max} notes")
        now = self._clock()
        note = Note(
            id=uuid4().hex,
            text=request.text.strip(),
            x=request.x,
            y=request.y,
            z=self._next_z,
            created_at=now,
            updated_at=now,
        )
        self._next_z += 1
        self._notes[note.id] = note
        self._persist()
        return note

    def update(self, note_id: str, request: NoteUpdateRequest) -> Note:
        current = self._notes.get(note_id)
        if current is None:
            raise KeyError(note_id)
        if request.text is not None:
            current.text = request.text.strip()
        if request.x is not None:
            current.x = request.x
        if request.y is not None:
            current.y = request.y
        current.z = self._next_z
        self._next_z += 1
        current.updated_at = self._clock()
        self._persist()
        return current

    def delete(self, note_id: str) -> Note:
        current = self._notes.pop(note_id, None)
        if current is None:
            raise KeyError(note_id)
        self._persist()
        return current

    # -- persistence ---------------------------------------------------------

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            notes = [Note.model_validate(entry) for entry in raw.get("notes", [])]
        except (OSError, ValueError, ValidationError) as exc:
            logger.warning("notes file %s unreadable (%s) — starting empty", self._path, exc)
            return
        self._notes = {note.id: note for note in notes}
        self._next_z = max((note.z for note in notes), default=0) + 1

    def _persist(self) -> None:
        if self._path is None:
            return
        payload = {"notes": [note.model_dump(mode="json") for note in self._notes.values()]}
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=".notes-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
            os.replace(tmp, self._path)
        except OSError as exc:  # noqa: BLE001 - persistence is best-effort
            logger.warning("could not persist notes to %s: %s", self._path, exc)


# -- process-wide singleton ---------------------------------------------------

_store: NoteStore | None = None


def get_note_store() -> NoteStore:
    global _store
    if _store is None:
        from app.config import get_settings

        settings = get_settings()
        _store = NoteStore(path=settings.notes_file or None)
    return _store


def reset_note_store() -> None:
    """Drop the singleton (tests / a fresh process)."""
    global _store
    _store = None
