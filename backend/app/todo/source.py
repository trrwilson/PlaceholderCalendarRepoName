"""The seam between the To Do sync service and a task source (Graph or mock).

A source returns already-mapped provider-neutral models plus an opaque link to
resume from — it never leaks Graph JSON past this boundary. The three error
types are the only control flow the service needs to understand.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from app.models import TaskItem, TaskList


@dataclass
class DeltaResult[T]:
    upserts: list[T] = field(default_factory=list)
    removed_ids: list[str] = field(default_factory=list)
    # Opaque link for the next incremental round (a Graph ``@odata.deltaLink``).
    next_link: str | None = None
    # True when this round started from scratch (no link): the result is the
    # complete current set, so anything cached but absent was deleted.
    is_baseline: bool = False


class DeltaExpired(Exception):
    """The stored link is no longer valid (Graph 410 Gone). Re-baseline."""


class TodoAuthRequired(Exception):
    """The account has no usable Tasks.Read token (never consented / revoked)."""


class Throttled(Exception):
    def __init__(self, retry_after: float) -> None:
        super().__init__(f"throttled; retry after {retry_after:.0f}s")
        self.retry_after = retry_after


class TodoSource(Protocol):
    def accounts(self) -> list[str]:
        """Account ids (== the owning HouseholdCalendar.id) to sync."""
        ...

    def list_delta(self, account: str, link: str | None) -> DeltaResult[TaskList]: ...

    def task_delta(self, account: str, list_id: str, link: str | None) -> DeltaResult[TaskItem]: ...
