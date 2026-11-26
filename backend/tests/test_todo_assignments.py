"""Shared-list assignee/creator from the To Do apps' API: mapping and fail-open."""

from __future__ import annotations

from datetime import date, datetime

import httpx
import pytest

from app.todo.assignments import SUBSTRATE_BASE, AssignmentReader, TaskPeople
from app.todo.mock import MockTodoSource
from app.todo.service import TodoSyncService

NOW = datetime(2026, 11, 9, 9, 0)
FOLDER = f"{SUBSTRATE_BASE}/taskfolders/L%3D1"
MEMBERS = {
    "Value": [
        {"Id": "SARAH", "DisplayName": "Sarah Shapro", "IsOwner": True},
        {"Id": "TRAVIS", "DisplayName": "Travis Wilson", "IsOwner": False},
    ]
}


def _reader(routes: dict[str, httpx.Response] | None = None, token=None) -> AssignmentReader:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer tok"
        return (routes or {}).get(str(request.url), httpx.Response(404))

    return AssignmentReader(
        httpx.Client(transport=httpx.MockTransport(handler)),
        token or (lambda account, scopes: "tok"),
    )


def test_maps_assignee_and_creator_through_members() -> None:
    tasks = {
        "Value": [
            {
                "Id": "t1",
                "CreatedByUser": {"Id": "SARAH"},
                "Assignments": [
                    {"Assignee": {"Id": "SARAH"}, "AssignedDateTime": "2026-11-20T10:00:00Z"},
                    {"Assignee": {"Id": "TRAVIS"}, "AssignedDateTime": "2026-11-25T17:59:11Z"},
                ],
            },
            {"Id": "t2", "CreatedByUser": {"Id": "TRAVIS"}, "Assignments": []},
            {"Id": "t3", "CreatedByUser": {"Id": "STRANGER", "DisplayName": None}},
        ],
        "DeltaLink": "ignored",
    }
    reader = _reader(
        {
            f"{FOLDER}/members": httpx.Response(200, json=MEMBERS),
            f"{FOLDER}/tasks": httpx.Response(200, json=tasks),
        }
    )
    assert reader.read("a@x.com", "L=1") == {
        "t1": TaskPeople(assignee_name="Travis Wilson", created_by_name="Sarah Shapro"),
        "t2": TaskPeople(assignee_name=None, created_by_name="Travis Wilson"),
        "t3": TaskPeople(),
    }


@pytest.mark.parametrize(
    "routes",
    [
        {},  # endpoint gone (404)
        {f"{FOLDER}/members": httpx.Response(500)},
        {
            f"{FOLDER}/members": httpx.Response(200, json=MEMBERS),
            f"{FOLDER}/tasks": httpx.Response(200, json={"items": "renamed"}),
        },
        {
            f"{FOLDER}/members": httpx.Response(200, text="<html>not json</html>"),
        },
    ],
)
def test_any_failure_fails_open(routes) -> None:
    assert _reader(routes).read("a@x.com", "L=1") is None


def test_missing_token_fails_open() -> None:
    def refuse(account, scopes):
        raise RuntimeError("no consent for the outlook audience")

    assert _reader(token=refuse).read("a@x.com", "L=1") is None


def _service(source: MockTodoSource) -> TodoSyncService:
    service = TodoSyncService(source, clock=lambda: NOW)
    service.sync_once()
    return service


def _task(service: TodoSyncService, task_id: str):
    return next(t for t in service.snapshot().tasks if t.id == task_id)


def test_service_stamps_shared_lists_only() -> None:
    service = _service(MockTodoSource(today=lambda: date(2026, 11, 9)))
    assert _task(service, "t4").assignee_name == "Jordan"
    assert _task(service, "t4").created_by_name == "Alex"
    assert _task(service, "t5").assignee_name is None
    assert _task(service, "t1").assignee_name is None  # alex-tasks is not shared


def test_service_clears_names_when_the_source_goes_away() -> None:
    class Flaky(MockTodoSource):
        down = False

        def people(self, account, list_id):
            return None if self.down else super().people(account, list_id)

    source = Flaky(today=lambda: date(2026, 11, 9))
    service = _service(source)
    assert _task(service, "t4").assignee_name == "Jordan"
    source.down = True
    assert service.sync_once() is True
    assert _task(service, "t4").assignee_name is None
    assert _task(service, "t4").created_by_name is None
    assert service.snapshot().status == "ok"  # never degrades the To Do sync


def test_completion_keeps_the_names() -> None:
    service = _service(MockTodoSource(today=lambda: date(2026, 11, 9)))
    service.set_completed("house", "t4", True)
    assert _task(service, "t4").status == "completed"
    assert _task(service, "t4").assignee_name == "Jordan"
