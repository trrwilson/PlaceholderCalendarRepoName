"""Read-only Microsoft To Do display (issue #5, docs/todo-integration-plan.md).

Feature-flagged by ``MISSION_CONTROL_TODO_ENABLED``. A disabled install never
builds the service, starts a loop, or imports the Graph source.
"""

from __future__ import annotations

from app.models import TaskSnapshot
from app.todo.service import TodoSyncService

_service: TodoSyncService | None = None


def get_todo_service() -> TodoSyncService | None:
    """The process-wide service, or ``None`` when the feature is off."""
    global _service
    from app.config import get_settings

    settings = get_settings()
    if not settings.todo_enabled:
        return None
    if _service is None:
        from app.realtime import connections

        if settings.todo_provider == "graph":
            from app.todo.graph_todo import GraphTodoSource

            source = GraphTodoSource(settings)
        else:
            from app.todo.mock import MockTodoSource

            source = MockTodoSource()
        _service = TodoSyncService(
            source,
            broadcast=connections.broadcast,
            path=settings.todo_state_file or None,
            interval_seconds=settings.todo_sync_interval_seconds,
        )
    return _service


def todo_snapshot() -> TaskSnapshot:
    service = get_todo_service()
    return service.snapshot() if service is not None else TaskSnapshot(status="disabled")


def start_todo_service() -> None:
    service = get_todo_service()
    if service is not None:
        service.start()


async def stop_todo_service() -> None:
    if _service is not None:
        await _service.stop()


def reset_todo_service() -> None:
    global _service
    _service = None
