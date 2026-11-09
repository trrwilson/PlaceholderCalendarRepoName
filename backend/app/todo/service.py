"""Background To Do sync: delta rounds into an in-memory snapshot + one JSON file.

Same mould as the feature stores (injected clock + broadcast, no socket import).
``sync_once`` is synchronous and deterministic so tests drive it directly; the
asyncio loop in ``run`` only adds scheduling and the push. Every failure is
caught here and only changes ``TaskSnapshot.status`` — To Do can never degrade
the calendar. See docs/todo-integration-plan.md.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.models import ApplicationMessage, TaskItem, TaskList, TaskSnapshot, TaskStatus
from app.todo.source import DeltaExpired, Throttled, TodoAuthRequired, TodoSource

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]
Broadcast = Callable[[ApplicationMessage], Awaitable[None]]

_STATE_VERSION = 1
_MAX_BACKOFF_SECONDS = 600.0


async def _noop_broadcast(_message: ApplicationMessage) -> None:
    return None


class TodoSyncService:
    def __init__(
        self,
        source: TodoSource,
        *,
        clock: Clock | None = None,
        broadcast: Broadcast | None = None,
        path: str | os.PathLike[str] | None = None,
        interval_seconds: float = 60.0,
    ) -> None:
        self._source = source
        self._clock: Clock = clock or datetime.now
        self._broadcast: Broadcast = broadcast or _noop_broadcast
        self._path = Path(path) if path else None
        self._interval = interval_seconds
        self._lists: dict[str, TaskList] = {}
        self._tasks: dict[str, dict[str, TaskItem]] = {}
        # Which account syncs each list (a shared list is visible to several).
        self._list_account: dict[str, str] = {}
        self._list_links: dict[str, str] = {}
        self._task_links: dict[str, str] = {}
        self._account_errors: dict[str, str] = {}
        self._synced_at: datetime | None = None
        self._has_synced = False
        self._no_accounts = False
        self._throttled_until: datetime | None = None
        self._failures = 0
        self._task: asyncio.Task[None] | None = None
        self._load()

    # -- reads ------------------------------------------------------------------

    def snapshot(self) -> TaskSnapshot:
        lists = sorted(
            self._lists.values(),
            key=lambda item: (item.owner_id, not item.is_default, item.name.casefold()),
        )
        tasks = [task for list_id in self._lists for task in self._tasks.get(list_id, {}).values()]
        tasks.sort(key=_task_sort_key)
        return TaskSnapshot(
            lists=lists,
            tasks=tasks,
            synced_at=self._synced_at,
            status=self._status(),
            error=next(iter(self._account_errors.values()), None),
        )

    def _status(self) -> str:
        if self._no_accounts:
            return "needs_sign_in"
        if self._account_errors:
            if any(err.startswith("auth:") for err in self._account_errors.values()):
                return "needs_sign_in"
            return "stale"
        if not self._has_synced:
            return "stale"
        return "ok"

    # -- sync -------------------------------------------------------------------

    def sync_once(self) -> bool:
        """One delta pass over every account. Returns whether the snapshot changed."""
        before = self._comparable()
        now = self._clock()
        if self._throttled_until is not None and now < self._throttled_until:
            return False
        self._throttled_until = None
        accounts = self._source.accounts()
        self._no_accounts = not accounts
        errors: dict[str, str] = {}
        for account in accounts:
            try:
                self._sync_account(account)
            except TodoAuthRequired as exc:
                errors[account] = f"auth: {exc}"
            except Throttled as exc:
                self._throttled_until = now + timedelta(seconds=exc.retry_after)
                errors[account] = str(exc)
                break
            except Exception as exc:  # noqa: BLE001 - isolate any provider failure
                logger.warning("To Do sync failed for %s: %s", account, exc)
                errors[account] = f"sync failed: {exc}"
        # An account that vanished (signed out) takes its lists with it.
        for list_id in [lid for lid, acct in self._list_account.items() if acct not in accounts]:
            self._drop_list(list_id)
        self._account_errors = errors
        self._failures = self._failures + 1 if errors else 0
        if not errors and accounts:
            self._has_synced = True
            self._synced_at = now
        changed = self._comparable() != before
        self._save()
        return changed

    def _sync_account(self, account: str) -> None:
        link = self._list_links.get(account)
        try:
            result = self._source.list_delta(account, link)
        except DeltaExpired:
            self._list_links.pop(account, None)
            result = self._source.list_delta(account, None)
        if result.is_baseline:
            seen = {item.id for item in result.upserts}
            for list_id in [
                lid
                for lid, acct in self._list_account.items()
                if acct == account and lid not in seen
            ]:
                self._drop_list(list_id)
        for list_id in result.removed_ids:
            if self._list_account.get(list_id) == account:
                self._drop_list(list_id)
        for item in result.upserts:
            owner = self._list_account.get(item.id)
            if owner is not None and owner != account:
                # Shared list already synced by another member: keep one copy,
                # preferring the owner's. [verify] that a shared To Do list keeps
                # the same id across accounts — if not, it will show twice.
                if self._lists[item.id].is_owner or not item.is_owner:
                    continue
                self._drop_list(item.id)
            self._lists[item.id] = item
            self._list_account[item.id] = account
            self._tasks.setdefault(item.id, {})
        if result.next_link:
            self._list_links[account] = result.next_link

        for list_id in [lid for lid, acct in self._list_account.items() if acct == account]:
            self._sync_list(account, list_id)

    def _sync_list(self, account: str, list_id: str) -> None:
        link = self._task_links.get(list_id)
        try:
            result = self._source.task_delta(account, list_id, link)
        except DeltaExpired:
            logger.info("To Do delta link expired for list %s; re-baselining", list_id)
            self._task_links.pop(list_id, None)
            result = self._source.task_delta(account, list_id, None)
        tasks = {} if result.is_baseline else dict(self._tasks.get(list_id, {}))
        for task_id in result.removed_ids:
            tasks.pop(task_id, None)
        for task in result.upserts:
            tasks[task.id] = task
        self._tasks[list_id] = tasks
        if result.next_link:
            self._task_links[list_id] = result.next_link

    def _drop_list(self, list_id: str) -> None:
        self._lists.pop(list_id, None)
        self._tasks.pop(list_id, None)
        self._list_account.pop(list_id, None)
        self._task_links.pop(list_id, None)

    def _comparable(self) -> dict[str, Any]:
        return self.snapshot().model_dump(mode="json", exclude={"synced_at"})

    def next_delay(self) -> float:
        if self._throttled_until is not None:
            return max(1.0, (self._throttled_until - self._clock()).total_seconds())
        if self._failures:
            return min(_MAX_BACKOFF_SECONDS, self._interval * (2 ** min(self._failures - 1, 4)))
        return self._interval

    # -- loop -------------------------------------------------------------------

    async def run(self) -> None:
        while True:
            try:
                changed = await asyncio.to_thread(self.sync_once)
                if changed:
                    await self._broadcast(
                        ApplicationMessage(
                            type="tasks", message="tasks updated", tasks=self.snapshot()
                        )
                    )
            except Exception:  # noqa: BLE001 - the loop must survive anything
                logger.exception("To Do sync loop error")
            await asyncio.sleep(self.next_delay())

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self.run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    # -- persistence ------------------------------------------------------------

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if data.get("version") != _STATE_VERSION:
                raise ValueError("unknown state version")
            snapshot = TaskSnapshot.model_validate(data.get("snapshot") or {})
            list_account = {str(k): str(v) for k, v in (data.get("list_account") or {}).items()}
        except (OSError, ValueError, ValidationError, AttributeError) as exc:
            logger.warning(
                "Ignoring unreadable To Do state %s (%s); will re-baseline", self._path, exc
            )
            return
        self._list_links = {str(k): str(v) for k, v in (data.get("list_links") or {}).items()}
        self._task_links = {str(k): str(v) for k, v in (data.get("task_links") or {}).items()}
        for item in snapshot.lists:
            if item.id in list_account:
                self._lists[item.id] = item
                self._list_account[item.id] = list_account[item.id]
                self._tasks[item.id] = {}
        for task in snapshot.tasks:
            if task.list_id in self._tasks:
                self._tasks[task.list_id][task.id] = task
        self._synced_at = snapshot.synced_at

    def _save(self) -> None:
        if self._path is None:
            return
        snapshot = self.snapshot()
        payload = {
            "version": _STATE_VERSION,
            "list_links": self._list_links,
            "task_links": self._task_links,
            "list_account": self._list_account,
            "snapshot": snapshot.model_dump(mode="json"),
        }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=self._path.name, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            os.replace(tmp, self._path)
        except OSError as exc:
            logger.warning("Could not persist To Do state to %s: %s", self._path, exc)


def _task_sort_key(task: TaskItem) -> tuple:
    done = task.status == TaskStatus.completed
    return (done, task.due_on is None, task.due_on or datetime.max.date(), task.title.casefold())
