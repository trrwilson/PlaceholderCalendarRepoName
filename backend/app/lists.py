"""Backend-owned household lists (a grocery list, for now) + JSON persistence.

Unlike the timer store, a list **is** durable: a wall appliance that forgets the
grocery list on every reboot is broken UX. The store is the single source of
truth, holds lists in process memory, persists them to one git-ignored JSON file
(``MISSION_CONTROL_LISTS_FILE``) on every change, and pushes updates to the kiosk
over ``/api/ws``. This is the same "one JSON file, no datastore" class as the
MSAL token cache — ``AGENTS.md`` already anticipates a SQLite store dropping in
behind this shape. See ``docs/lists-plan.md``.

For this task there is **one list** (``grocery``), keyed by id in a ``dict`` so
moving to several named lists is config + a picker, not a rewrite.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from collections.abc import Awaitable, Callable, Iterable
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from app.models import (
    GROCERY_LIST_ID,
    LIST_ITEM_NAME_MAX,
    ApplicationMessage,
    GroceryList,
    ListClearScope,
    ListItem,
    ListItemSource,
    ListItemUpdateRequest,
    ListMutationResult,
)

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
Broadcast = Callable[[ApplicationMessage], Awaitable[None]]

RECENT_NAMES_MAX = 20


class ListError(ValueError):
    """An invalid list request (blank item, unknown list/item)."""


def _normalize(name: str) -> str:
    """Loose identity for dedupe: lowercased, trimmed, whitespace collapsed, and
    a trailing plural 's' dropped so "eggs" matches "egg"."""
    base = re.sub(r"\s+", " ", name.strip().lower())
    return re.sub(r"s$", "", base) if len(base) > 3 else base


async def _noop_broadcast(_message: ApplicationMessage) -> None:
    return None


class ListStore:
    def __init__(
        self,
        *,
        clock: Clock | None = None,
        broadcast: Broadcast | None = None,
        path: str | os.PathLike[str] | None = None,
        recent_names_max: int = RECENT_NAMES_MAX,
    ) -> None:
        self._clock: Clock = clock or datetime.now
        self._broadcast: Broadcast = broadcast or _noop_broadcast
        self._path = Path(path) if path is not None else None
        self._recent_max = recent_names_max
        self._lists: dict[str, GroceryList] = {}
        self._load()

    # -- reads ---------------------------------------------------------------

    def list_all(self) -> list[GroceryList]:
        return list(self._lists.values())

    def get(self, list_id: str) -> GroceryList | None:
        return self._lists.get(list_id)

    def _require(self, list_id: str) -> GroceryList:
        current = self._lists.get(list_id)
        if current is None:
            raise KeyError(list_id)
        return current

    # -- mutations ---------------------------------------------------------------

    async def add_items(
        self,
        list_id: str,
        names: Iterable[str],
        *,
        note: str | None = None,
        source: ListItemSource = ListItemSource.touch,
    ) -> ListMutationResult:
        current = self._require(list_id)
        now = self._clock()
        added: list[str] = []
        already: list[str] = []
        for raw in names:
            name = raw.strip()
            if not name:
                continue
            existing = self._find(current, name)
            if existing is not None and not existing.checked:
                already.append(existing.name)
                continue
            if existing is not None and existing.checked:
                # "add milk" when milk is checked off — put it back on.
                existing.checked = False
                existing.checked_at = None
                existing.added_at = now
                current.items.remove(existing)
                current.items.insert(0, existing)
                added.append(existing.name)
            else:
                current.items.insert(
                    0,
                    ListItem(
                        id=uuid4().hex,
                        name=name,
                        note=(note or None),
                        added_at=now,
                        source=source,
                    ),
                )
                added.append(name)
            self._remember(current, name)
        current.updated_at = now
        self._persist()
        if added:
            what = _join(added)
            await self._emit("list-item-added", f"Added {what}", current)
        return ListMutationResult(list=current, added=added, already_present=already)

    async def update_item(
        self, list_id: str, item_id: str, request: ListItemUpdateRequest
    ) -> ListMutationResult:
        current = self._require(list_id)
        item = next((i for i in current.items if i.id == item_id), None)
        if item is None:
            raise KeyError(item_id)
        now = self._clock()
        toggled: bool | None = None
        if request.checked is not None and request.checked != item.checked:
            item.checked = request.checked
            item.checked_at = now if request.checked else None
            toggled = request.checked
        if request.name is not None and request.name.strip():
            item.name = request.name.strip()[:LIST_ITEM_NAME_MAX]
        if request.note is not None:
            item.note = request.note.strip() or None
        current.updated_at = now
        self._persist()
        if toggled is True:
            await self._emit("list-item-checked", f"Checked off {item.name}", current)
        elif toggled is False:
            await self._emit("list-item-unchecked", f"Back on the list: {item.name}", current)
        return ListMutationResult(list=current)

    async def remove_item(self, list_id: str, item_id: str) -> ListMutationResult:
        current = self._require(list_id)
        item = next((i for i in current.items if i.id == item_id), None)
        if item is None:
            raise KeyError(item_id)
        current.items.remove(item)
        current.updated_at = self._clock()
        self._persist()
        await self._emit("list-item-removed", f"Removed {item.name}", current, removed=[item])
        return ListMutationResult(list=current, removed=[item])

    async def clear(self, list_id: str, scope: ListClearScope) -> ListMutationResult:
        current = self._require(list_id)
        if scope == ListClearScope.checked:
            removed = [i for i in current.items if i.checked]
            current.items = [i for i in current.items if not i.checked]
        else:
            removed = list(current.items)
            current.items = []
        current.updated_at = self._clock()
        self._persist()
        if removed:
            noun = "item" if len(removed) == 1 else "items"
            await self._emit(
                "list-cleared",
                f"Cleared {len(removed)} {noun} ({scope.value})",
                current,
                removed=removed,
            )
        return ListMutationResult(list=current, removed=removed)

    async def restore(self, list_id: str, items: list[ListItem]) -> ListMutationResult:
        current = self._require(list_id)
        have = {i.id for i in current.items}
        restored = [i for i in items if i.id not in have]
        # Prepend in the order they were removed — this keeps a custom manual
        # order intact when a clear is undone (``removed`` preserved the order).
        current.items = restored + current.items
        current.updated_at = self._clock()
        self._persist()
        if restored:
            await self._emit("list-restored", f"Restored {len(restored)}", current)
        return ListMutationResult(list=current, added=[i.name for i in restored])

    async def reorder(self, list_id: str, item_ids: list[str]) -> ListMutationResult:
        """Apply a custom item order. ``item_ids`` need not be complete — any
        item it does not name keeps its current relative position, after the
        named ones (the kiosk sends just the reordered 'to get' section)."""
        current = self._require(list_id)
        by_id = {i.id: i for i in current.items}
        named = [by_id[i] for i in item_ids if i in by_id]
        named_ids = {i.id for i in named}
        rest = [i for i in current.items if i.id not in named_ids]
        reordered = named + rest
        if [i.id for i in reordered] == [i.id for i in current.items]:
            return ListMutationResult(list=current)  # no-op
        current.items = reordered
        current.updated_at = self._clock()
        self._persist()
        await self._emit("list-reordered", "Reordered the list", current)
        return ListMutationResult(list=current)

    # -- helpers ---------------------------------------------------------------

    @staticmethod
    def _find(current: GroceryList, name: str) -> ListItem | None:
        target = _normalize(name)
        return next((i for i in current.items if _normalize(i.name) == target), None)

    def _remember(self, current: GroceryList, name: str) -> None:
        lowered = name.strip()
        kept = [n for n in current.recent_names if _normalize(n) != _normalize(lowered)]
        current.recent_names = [lowered, *kept][: self._recent_max]

    async def _emit(
        self,
        message_type: str,
        message: str,
        changed: GroceryList,
        *,
        removed: list[ListItem] | None = None,
    ) -> None:
        await self._broadcast(
            ApplicationMessage(
                type=message_type,
                message=message,
                lists=self.list_all(),
                list=changed,
                removed=removed or None,
            )
        )

    # -- persistence ---------------------------------------------------------

    def _seed(self) -> None:
        self._lists = {GROCERY_LIST_ID: GroceryList(id=GROCERY_LIST_ID, updated_at=self._clock())}

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            self._seed()
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            lists = [GroceryList.model_validate(entry) for entry in raw.get("lists", [])]
            self._lists = {gl.id: gl for gl in lists}
        except (OSError, ValueError, ValidationError) as exc:
            logger.warning("lists file %s unreadable (%s) — starting fresh", self._path, exc)
            self._seed()
            return
        if GROCERY_LIST_ID not in self._lists:
            self._lists[GROCERY_LIST_ID] = GroceryList(id=GROCERY_LIST_ID, updated_at=self._clock())

    def _persist(self) -> None:
        if self._path is None:
            return
        payload = {
            "lists": [gl.model_dump(mode="json") for gl in self._lists.values()],
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=".lists-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
            os.replace(tmp, self._path)
        except OSError as exc:  # noqa: BLE001 - persistence is best-effort
            logger.warning("could not persist lists to %s: %s", self._path, exc)


def _join(names: list[str]) -> str:
    if len(names) <= 1:
        return names[0] if names else ""
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return ", ".join(names[:-1]) + f", and {names[-1]}"


# -- process-wide singleton ---------------------------------------------------

_store: ListStore | None = None


def get_list_store() -> ListStore:
    global _store
    if _store is None:
        from app.config import get_settings
        from app.realtime import connections

        settings = get_settings()
        _store = ListStore(
            broadcast=connections.broadcast,
            path=settings.lists_file or None,
            recent_names_max=settings.lists_recent_items_max,
        )
    return _store


def reset_list_store() -> None:
    """Drop the singleton (tests / a fresh process)."""
    global _store
    _store = None
