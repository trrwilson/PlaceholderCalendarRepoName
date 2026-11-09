"""To Do sync: Graph delta mapping, incremental rounds, resync, isolation, gates."""

from __future__ import annotations

import json
from datetime import date, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.models import TaskStatus
from app.todo import reset_todo_service
from app.todo.graph_todo import GraphTodoSource, due_date
from app.todo.mock import MockTodoSource
from app.todo.service import TodoSyncService
from app.todo.source import TodoAuthRequired

BASE = "https://graph.microsoft.com/v1.0"
NOW = datetime(2026, 11, 9, 9, 0)


class FakeGraph:
    """Routes Graph URLs to queued JSON responses (or status codes)."""

    def __init__(self) -> None:
        self.routes: dict[str, list[tuple[int, dict, dict]]] = {}
        self.calls: list[str] = []

    def add(
        self, url: str, body: dict | None = None, status: int = 200, headers: dict | None = None
    ) -> None:
        self.routes.setdefault(url, []).append((status, body or {}, headers or {}))

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append(url)
        queue = self.routes.get(url)
        if not queue:
            return httpx.Response(404, json={"error": url})
        status, body, headers = queue.pop(0) if len(queue) > 1 else queue[0]
        return httpx.Response(status, json=body, headers=headers)


def _source(fake: FakeGraph, accounts=("a@x.com",), **settings) -> GraphTodoSource:
    return GraphTodoSource(
        Settings(_env_file=None, **settings),
        client=httpx.Client(transport=httpx.MockTransport(fake.handler)),
        token_provider=lambda account, scopes: "tok",
        accounts=lambda: list(accounts),
    )


def _lists_baseline(fake: FakeGraph, lists: list[dict], link: str = "L1") -> None:
    fake.add(
        f"{BASE}/me/todo/lists/delta",
        {"value": lists, "@odata.deltaLink": f"{BASE}/lists-delta?t={link}"},
    )


def _task(id_: str, title: str, **extra) -> dict:
    return {"id": id_, "title": title, "status": "notStarted", "importance": "normal", **extra}


# -- mapping -------------------------------------------------------------------


def test_due_date_utc_midnight_is_the_date_itself() -> None:
    # To Do writes a date as midnight UTC; converting to a US zone would give the day before.
    assert due_date({"dateTime": "2026-11-12T00:00:00.0000000", "timeZone": "UTC"}) == date(
        2026, 11, 12
    )


def test_due_date_missing_or_garbage() -> None:
    assert due_date(None) is None
    assert due_date({"dateTime": "nope", "timeZone": "UTC"}) is None


def test_baseline_maps_fields_and_paginates() -> None:
    fake = FakeGraph()
    _lists_baseline(
        fake,
        [{"id": "L", "displayName": "Tasks", "wellknownListName": "defaultList", "isOwner": True}],
    )
    fake.add(
        f"{BASE}/me/todo/lists/L/tasks/delta",
        {"value": [_task("1", "One")], "@odata.nextLink": f"{BASE}/page2"},
    )
    fake.add(
        f"{BASE}/page2",
        {
            "value": [
                _task(
                    "2",
                    "Two",
                    status="completed",
                    importance="high",
                    categories=["Kids"],
                    dueDateTime={"dateTime": "2026-11-10T00:00:00.0000000", "timeZone": "UTC"},
                    checklistItems=[{"isChecked": True}, {"isChecked": False}],
                    body={"content": "note"},
                )
            ],
            "@odata.deltaLink": f"{BASE}/tasks-delta?t=T1",
        },
    )
    fake.add(
        f"{BASE}/me/outlook/masterCategories",
        {"value": [{"displayName": "Kids", "color": "preset4"}]},
    )
    service = TodoSyncService(_source(fake), clock=lambda: NOW)

    assert service.sync_once() is True
    snap = service.snapshot()
    assert snap.status == "ok"
    assert [lst.is_default for lst in snap.lists] == [True]
    assert snap.lists[0].owner_id == "a@x.com"
    two = next(t for t in snap.tasks if t.id == "2")
    assert two.status == TaskStatus.completed
    assert two.importance == "high"
    assert two.due_on == date(2026, 11, 10)
    assert two.category is not None and two.category.color == "#27ae60"
    assert (two.checklist_done, two.checklist_total, two.has_note) == (1, 2, True)
    # Open tasks sort before completed ones.
    assert [t.id for t in snap.tasks] == ["1", "2"]


def test_incremental_round_applies_upserts_and_removals() -> None:
    fake = FakeGraph()
    _lists_baseline(fake, [{"id": "L", "displayName": "Tasks"}])
    fake.add(
        f"{BASE}/lists-delta?t=L1", {"value": [], "@odata.deltaLink": f"{BASE}/lists-delta?t=L1"}
    )
    fake.add(
        f"{BASE}/me/todo/lists/L/tasks/delta",
        {
            "value": [_task("1", "One"), _task("2", "Two")],
            "@odata.deltaLink": f"{BASE}/tasks-delta?t=T1",
        },
    )
    fake.add(
        f"{BASE}/tasks-delta?t=T1",
        {
            "value": [
                {"id": "1", "@removed": {"reason": "deleted"}},
                _task("2", "Two!", status="completed"),
            ],
            "@odata.deltaLink": f"{BASE}/tasks-delta?t=T2",
        },
    )
    fake.add(
        f"{BASE}/tasks-delta?t=T2", {"value": [], "@odata.deltaLink": f"{BASE}/tasks-delta?t=T2"}
    )
    service = TodoSyncService(_source(fake), clock=lambda: NOW)
    service.sync_once()

    assert service.sync_once() is True
    tasks = service.snapshot().tasks
    assert [(t.id, t.title, t.status) for t in tasks] == [("2", "Two!", TaskStatus.completed)]
    # Nothing changed on the third round.
    assert service.sync_once() is False


def test_expired_delta_link_rebaselines_that_list_without_retrying_it() -> None:
    fake = FakeGraph()
    _lists_baseline(fake, [{"id": "L", "displayName": "Tasks"}])
    fake.add(
        f"{BASE}/lists-delta?t=L1", {"value": [], "@odata.deltaLink": f"{BASE}/lists-delta?t=L1"}
    )
    fake.add(
        f"{BASE}/me/todo/lists/L/tasks/delta",
        {"value": [_task("1", "Stale")], "@odata.deltaLink": f"{BASE}/tasks-delta?t=T1"},
    )
    service = TodoSyncService(_source(fake), clock=lambda: NOW)
    service.sync_once()
    # Now the link is gone and the baseline returns a fresh set.
    fake.routes[f"{BASE}/tasks-delta?t=T1"] = [(410, {"error": {"code": "syncStateNotFound"}}, {})]
    fake.routes[f"{BASE}/me/todo/lists/L/tasks/delta"] = [
        (200, {"value": [_task("9", "Fresh")], "@odata.deltaLink": f"{BASE}/tasks-delta?t=T9"}, {})
    ]
    fake.calls.clear()

    assert service.sync_once() is True
    assert [t.id for t in service.snapshot().tasks] == ["9"]
    assert fake.calls.count(f"{BASE}/tasks-delta?t=T1") == 1


def test_throttle_honours_retry_after() -> None:
    fake = FakeGraph()
    fake.add(f"{BASE}/me/todo/lists/delta", status=429, headers={"Retry-After": "120"})
    clock = {"now": NOW}
    service = TodoSyncService(_source(fake), clock=lambda: clock["now"], interval_seconds=60)
    service.sync_once()
    assert service.snapshot().status == "stale"
    assert service.next_delay() == pytest.approx(120)
    fake.calls.clear()
    service.sync_once()  # still inside the window: no request at all
    assert fake.calls == []


def test_flagged_email_and_hidden_lists_are_skipped() -> None:
    fake = FakeGraph()
    _lists_baseline(
        fake,
        [
            {"id": "F", "displayName": "Flagged email", "wellknownListName": "flaggedEmails"},
            {"id": "S", "displayName": "Someday"},
            {"id": "L", "displayName": "Tasks"},
        ],
    )
    fake.add(f"{BASE}/me/todo/lists/L/tasks/delta", {"value": [], "@odata.deltaLink": f"{BASE}/t"})
    service = TodoSyncService(_source(fake, todo_hidden_list_names=["someday"]), clock=lambda: NOW)
    service.sync_once()
    assert [lst.id for lst in service.snapshot().lists] == ["L"]


def test_shared_list_visible_to_two_accounts_appears_once_under_its_owner() -> None:
    fake = FakeGraph()
    # Both accounts see list "H"; b@ owns it. One token-agnostic fake serves both.
    fake.add(
        f"{BASE}/me/todo/lists/delta",
        {
            "value": [{"id": "H", "displayName": "House", "isOwner": False, "isShared": True}],
            "@odata.deltaLink": f"{BASE}/la",
        },
    )
    fake.add(
        f"{BASE}/me/todo/lists/delta",
        {
            "value": [{"id": "H", "displayName": "House", "isOwner": True, "isShared": True}],
            "@odata.deltaLink": f"{BASE}/lb",
        },
    )
    fake.add(
        f"{BASE}/me/todo/lists/H/tasks/delta",
        {"value": [_task("1", "Paint")], "@odata.deltaLink": f"{BASE}/t"},
    )
    service = TodoSyncService(_source(fake, accounts=("a@x.com", "b@x.com")), clock=lambda: NOW)
    service.sync_once()
    snap = service.snapshot()
    assert [(lst.id, lst.owner_id) for lst in snap.lists] == [("H", "b@x.com")]
    assert [t.id for t in snap.tasks] == ["1"]


def test_missing_consent_marks_needs_sign_in_and_keeps_cached_tasks() -> None:
    state = {"fail": False}

    class Flaky(MockTodoSource):
        def list_delta(self, account, link):
            if state["fail"]:
                raise TodoAuthRequired("no consent")
            return super().list_delta(account, link)

    service = TodoSyncService(Flaky(today=lambda: NOW.date()), clock=lambda: NOW)
    service.sync_once()
    cached = len(service.snapshot().tasks)
    state["fail"] = True
    service.sync_once()
    snap = service.snapshot()
    assert snap.status == "needs_sign_in"
    assert len(snap.tasks) == cached > 0


def test_todo_auth_failure_never_touches_calendar_auth_error() -> None:
    import app.calendar.outlook_personal as outlook_personal

    outlook_personal.auth_error = None

    def refuse(account, scopes):
        raise TodoAuthRequired("no consent")

    source = GraphTodoSource(
        Settings(_env_file=None),
        client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))),
        token_provider=refuse,
        accounts=lambda: ["a@x.com"],
    )
    TodoSyncService(source, clock=lambda: NOW).sync_once()
    assert outlook_personal.auth_error is None


def test_no_accounts_is_needs_sign_in() -> None:
    fake = FakeGraph()
    service = TodoSyncService(_source(fake, accounts=()), clock=lambda: NOW)
    service.sync_once()
    assert service.snapshot().status == "needs_sign_in"


# -- persistence -----------------------------------------------------------------


def test_state_file_round_trip_resumes_from_delta_links(tmp_path) -> None:
    path = tmp_path / "todo_state.json"
    fake = FakeGraph()
    _lists_baseline(fake, [{"id": "L", "displayName": "Tasks"}])
    fake.add(
        f"{BASE}/me/todo/lists/L/tasks/delta",
        {"value": [_task("1", "One")], "@odata.deltaLink": f"{BASE}/tasks-delta?t=T1"},
    )
    TodoSyncService(_source(fake), clock=lambda: NOW, path=path).sync_once()

    reloaded = TodoSyncService(_source(fake), clock=lambda: NOW, path=path)
    snap = reloaded.snapshot()
    assert [t.title for t in snap.tasks] == ["One"]
    assert snap.status == "stale"  # cached, not yet re-synced this process
    fake.add(
        f"{BASE}/lists-delta?t=L1", {"value": [], "@odata.deltaLink": f"{BASE}/lists-delta?t=L1"}
    )
    fake.add(
        f"{BASE}/tasks-delta?t=T1", {"value": [], "@odata.deltaLink": f"{BASE}/tasks-delta?t=T1"}
    )
    fake.calls.clear()
    reloaded.sync_once()
    assert f"{BASE}/me/todo/lists/delta" not in fake.calls
    assert reloaded.snapshot().status == "ok"


def test_corrupt_state_file_is_ignored(tmp_path) -> None:
    path = tmp_path / "todo_state.json"
    path.write_text("{not json", encoding="utf-8")
    service = TodoSyncService(MockTodoSource(), clock=lambda: NOW, path=path)
    assert service.snapshot().tasks == []
    service.sync_once()
    assert json.loads(path.read_text(encoding="utf-8"))["version"] == 1


# -- API -------------------------------------------------------------------------


@pytest.fixture
def lan(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()


def test_tasks_route_reports_disabled_by_default(lan) -> None:
    from app.main import app

    response = TestClient(app).get("/api/tasks")
    assert response.status_code == 200
    assert response.json()["status"] == "disabled"


def test_tasks_route_serves_mock_snapshot_when_enabled(
    lan, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.main import app
    from app.todo import get_todo_service

    monkeypatch.setenv("MISSION_CONTROL_TODO_ENABLED", "true")
    get_settings.cache_clear()
    reset_todo_service()
    get_todo_service().sync_once()
    body = TestClient(app).get("/api/tasks").json()
    assert body["status"] == "ok"
    assert {lst["owner_id"] for lst in body["lists"]} == {"alex", "jordan"}


def test_tasks_route_is_lan_only() -> None:
    from app.main import app

    client = TestClient(app, client=("8.8.8.8", 1234))
    assert client.get("/api/tasks").status_code == 403


def test_sign_in_scopes_add_tasks_only_for_graph_todo() -> None:
    from app.calendar.outlook_personal import sign_in_scopes

    assert sign_in_scopes(Settings(_env_file=None)) == ["Calendars.Read"]
    assert sign_in_scopes(Settings(_env_file=None, todo_enabled=True)) == ["Calendars.Read"]
    assert sign_in_scopes(Settings(_env_file=None, todo_enabled=True, todo_provider="graph")) == [
        "Calendars.Read",
        "Tasks.Read",
    ]
