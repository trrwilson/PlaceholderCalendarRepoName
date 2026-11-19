"""Microsoft To Do (``/me/todo``) source over Microsoft Graph delta queries.

Delegated only: reuses the personal-Outlook MSAL client and on-disk token cache
(``app.calendar.outlook_personal.shared_msal_app``) with its own ``Tasks.Read``
scope request, so a member who has not consented to tasks never affects the
calendar's sign-in state. Read-only. See docs/todo-integration-plan.md.

Graph JSON is mapped to provider-neutral models here and nowhere else.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date, datetime
from typing import Any
from urllib.parse import quote

import httpx

from app.calendar.graph import (
    _GRAPH_BASE,
    CategoryColorCache,
    _category,
    _to_local_naive,
)
from app.config import Settings
from app.models import TaskImportance, TaskItem, TaskList, TaskStatus
from app.todo.source import DeltaExpired, DeltaResult, Throttled, TodoAuthRequired

logger = logging.getLogger(__name__)

TODO_SCOPES = ["Tasks.Read"]
# masterCategories is read with the calendar token, which already carries the
# mailbox access it needs, so tasks never ask for a mailbox scope of their own.
_CATEGORY_SCOPES = ["Calendars.Read"]

_STATUS = {
    "notStarted": TaskStatus.not_started,
    "inProgress": TaskStatus.in_progress,
    "completed": TaskStatus.completed,
    "waitingOnOthers": TaskStatus.waiting,
    "deferred": TaskStatus.deferred,
}
_IMPORTANCE = {
    "low": TaskImportance.low,
    "normal": TaskImportance.normal,
    "high": TaskImportance.high,
}
_DEFAULT_RETRY_AFTER = 30.0

# Token provider: (account, scopes) -> bearer token, or raise TodoAuthRequired.
TokenProvider = Callable[[str, list[str]], str]


def due_date(part: dict[str, Any] | None) -> date | None:
    """A To Do ``dateTimeTimeZone`` due value -> the household-local due date.

    To Do due dates are *dates*: the apps write midnight with ``timeZone: UTC``.
    Converting that instant to a US zone would land on the previous day, so a
    UTC midnight is taken as the date itself. Anything else (a real time, or a
    named zone) is converted to local time like an event. [verify] on hardware
    with ``backend/scripts/validate_todo_graph.py``.
    """
    if not part or not part.get("dateTime"):
        return None
    try:
        parsed = datetime.fromisoformat(part["dateTime"][:19])
    except ValueError:
        return None
    zone = (part.get("timeZone") or "UTC").upper()
    if zone in {"UTC", "ETC/UTC"} and parsed.time() == datetime.min.time():
        return parsed.date()
    try:
        return _to_local_naive(
            {"dateTime": parsed.isoformat(), "timeZone": part.get("timeZone")}
        ).date()
    except (KeyError, ValueError):
        return parsed.date()


def map_list(raw: dict[str, Any], owner_id: str) -> TaskList:
    return TaskList(
        id=raw["id"],
        name=(raw.get("displayName") or "").strip() or "Tasks",
        owner_id=owner_id,
        is_shared=bool(raw.get("isShared")) or raw.get("isOwner") is False,
        is_owner=raw.get("isOwner") is not False,
        is_default=raw.get("wellknownListName") == "defaultList",
    )


def map_task(raw: dict[str, Any], list_id: str, colors: dict[str, str]) -> TaskItem:
    completed = raw.get("completedDateTime")
    completed_at = None
    if completed and completed.get("dateTime"):
        try:
            completed_at = _to_local_naive(completed)
        except (KeyError, ValueError):
            completed_at = None
    categories = [name for name in raw.get("categories") or [] if name]
    checklist = raw.get("checklistItems") or []
    body = (raw.get("body") or {}).get("content") or ""
    return TaskItem(
        id=raw["id"],
        list_id=list_id,
        title=(raw.get("title") or "").strip() or "(untitled)",
        status=_STATUS.get(raw.get("status") or "", TaskStatus.not_started),
        importance=_IMPORTANCE.get(raw.get("importance") or "", TaskImportance.normal),
        due_on=due_date(raw.get("dueDateTime")),
        completed_at=completed_at,
        category=_category(categories[0], colors) if categories else None,
        checklist_total=len(checklist),
        checklist_done=sum(1 for item in checklist if item.get("isChecked")),
        has_note=bool(body.strip()),
    )


def _retry_after(response: httpx.Response) -> float:
    try:
        return max(1.0, float(response.headers.get("Retry-After", _DEFAULT_RETRY_AFTER)))
    except ValueError:
        return _DEFAULT_RETRY_AFTER


class GraphTodoSource:
    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.Client | None = None,
        token_provider: TokenProvider | None = None,
        accounts: Callable[[], list[str]] | None = None,
    ) -> None:
        self._settings = settings
        self._client = client or httpx.Client(timeout=30.0)
        self._category_colors = CategoryColorCache(self._client)
        self._token_provider = token_provider or self._msal_token
        self._accounts = accounts or self._msal_accounts
        hidden = {name.strip().casefold() for name in settings.todo_hidden_list_names}
        self._hidden_names = hidden

    # -- auth -------------------------------------------------------------------

    def _msal_accounts(self) -> list[str]:
        from app.calendar.outlook_personal import shared_msal_app

        app, _cache, _path = shared_msal_app(self._settings)
        return [str(a["username"]) for a in app.get_accounts() if a.get("username")]

    def _msal_token(self, account: str, scopes: list[str]) -> str:
        from app.calendar.outlook_personal import save_cache, shared_msal_app

        app, cache, path = shared_msal_app(self._settings)
        match = next((a for a in app.get_accounts() if a.get("username") == account), None)
        if match is None:
            raise TodoAuthRequired(f"{account} is not signed in")
        result = app.acquire_token_silent(scopes, account=match)
        save_cache(cache, path)
        if not result or "access_token" not in result:
            raise TodoAuthRequired(
                f"{account} has not allowed To Do access — sign in again from the kiosk"
            )
        return str(result["access_token"])

    def accounts(self) -> list[str]:
        return self._accounts()

    # -- delta ------------------------------------------------------------------

    def _rounds(self, url: str, token: str) -> tuple[list[dict[str, Any]], str | None]:
        """Follow nextLink pages to the deltaLink. Raises on 410/401/429."""
        headers = {"Authorization": f"Bearer {token}"}
        items: list[dict[str, Any]] = []
        next_url: str | None = url
        while next_url:
            response = self._client.get(next_url, headers=headers)
            if response.status_code == 410:
                raise DeltaExpired(response.text[:200])
            if response.status_code == 429:
                raise Throttled(_retry_after(response))
            if response.status_code in (401, 403):
                raise TodoAuthRequired(f"Graph refused To Do access ({response.status_code})")
            response.raise_for_status()
            body = response.json()
            items.extend(body.get("value", []))
            if "@odata.deltaLink" in body:
                return items, body["@odata.deltaLink"]
            next_url = body.get("@odata.nextLink")
        return items, None

    def _is_hidden(self, raw: dict[str, Any]) -> bool:
        if raw.get("wellknownListName") == "flaggedEmails":
            return not self._settings.todo_include_flagged_email
        name = (raw.get("displayName") or "").strip().casefold()
        return name in self._hidden_names

    def list_delta(self, account: str, link: str | None) -> DeltaResult[TaskList]:
        token = self._token_provider(account, TODO_SCOPES)
        raw_items, next_link = self._rounds(link or f"{_GRAPH_BASE}/me/todo/lists/delta", token)
        result: DeltaResult[TaskList] = DeltaResult(next_link=next_link, is_baseline=link is None)
        for raw in raw_items:
            if not raw.get("id"):
                continue
            if "@removed" in raw or self._is_hidden(raw):
                result.removed_ids.append(raw["id"])
                continue
            result.upserts.append(map_list(raw, account))
        return result

    def task_delta(self, account: str, list_id: str, link: str | None) -> DeltaResult[TaskItem]:
        token = self._token_provider(account, TODO_SCOPES)
        url = link or f"{_GRAPH_BASE}/me/todo/lists/{quote(list_id, safe='')}/tasks/delta"
        raw_items, next_link = self._rounds(url, token)
        colors: dict[str, str] = {}
        if any(raw.get("categories") for raw in raw_items):
            colors = self._colors(account)
        result: DeltaResult[TaskItem] = DeltaResult(next_link=next_link, is_baseline=link is None)
        for raw in raw_items:
            if not raw.get("id"):
                continue
            if "@removed" in raw:
                result.removed_ids.append(raw["id"])
            else:
                result.upserts.append(map_task(raw, list_id, colors))
        return result

    def _colors(self, account: str) -> dict[str, str]:
        """Best-effort master-category colours; never fails a sync."""
        try:
            token = self._token_provider(account, _CATEGORY_SCOPES)
        except TodoAuthRequired:
            return {}
        headers = {"Authorization": f"Bearer {token}"}
        return self._category_colors.get(f"{_GRAPH_BASE}/me", headers, account)
