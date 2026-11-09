"""Seeded, network-free To Do source for development and tests.

Owner ids match ``MockCalendarProvider``'s calendars so person colours line up.
Due dates are relative to today so the Home tile always has something to show.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta

from app.models import EventCategory, TaskImportance, TaskItem, TaskList, TaskStatus
from app.todo.source import DeltaResult


class MockTodoSource:
    def __init__(self, today: Callable[[], date] = date.today) -> None:
        self._today = today

    def accounts(self) -> list[str]:
        return ["alex", "jordan"]

    def _lists(self) -> dict[str, list[TaskList]]:
        return {
            "alex": [
                TaskList(id="alex-tasks", name="Tasks", owner_id="alex", is_default=True),
                TaskList(id="house", name="House", owner_id="alex", is_shared=True),
            ],
            "jordan": [
                TaskList(id="jordan-tasks", name="Tasks", owner_id="jordan", is_default=True),
            ],
        }

    def _tasks(self, list_id: str) -> list[TaskItem]:
        today = self._today()
        errands = EventCategory(id="errands", name="Errands", color="#e8890c")
        seeded = {
            "alex-tasks": [
                TaskItem(
                    id="t1",
                    list_id="alex-tasks",
                    title="Renew car registration",
                    due_on=today - timedelta(days=1),
                    importance=TaskImportance.high,
                    category=errands,
                ),
                TaskItem(id="t2", list_id="alex-tasks", title="Call the dentist", due_on=today),
                TaskItem(id="t3", list_id="alex-tasks", title="Book summer camp"),
            ],
            "house": [
                TaskItem(
                    id="t4",
                    list_id="house",
                    title="Get arborist quote",
                    due_on=today + timedelta(days=3),
                    checklist_total=3,
                    checklist_done=1,
                ),
                TaskItem(
                    id="t5",
                    list_id="house",
                    title="Replace furnace filter",
                    status=TaskStatus.completed,
                ),
            ],
            "jordan-tasks": [
                TaskItem(
                    id="t6",
                    list_id="jordan-tasks",
                    title="Return library books",
                    due_on=today,
                    category=errands,
                ),
                TaskItem(
                    id="t7",
                    list_id="jordan-tasks",
                    title="Research car insurance",
                    due_on=today + timedelta(days=6),
                    has_note=True,
                ),
            ],
        }
        return seeded.get(list_id, [])

    def list_delta(self, account: str, link: str | None) -> DeltaResult[TaskList]:
        if link:
            return DeltaResult(next_link=link)
        return DeltaResult(
            upserts=self._lists().get(account, []), next_link="mock", is_baseline=True
        )

    def task_delta(self, account: str, list_id: str, link: str | None) -> DeltaResult[TaskItem]:
        if link:
            return DeltaResult(next_link=link)
        return DeltaResult(upserts=self._tasks(list_id), next_link="mock", is_baseline=True)
