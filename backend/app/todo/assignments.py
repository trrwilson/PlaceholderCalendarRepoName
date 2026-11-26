"""Who a shared To Do task is assigned to, and who created it — best effort.

Graph's ``todoTask`` has no assignee or creator. The To Do apps' own API
(``substrate.office.com/todob2/api/v1``, undocumented — Microsoft may change or
remove it without notice) carries both: ``Assignments[].Assignee.Id`` and
``CreatedByUser.Id`` per task, and ``/members`` maps those ids to display names.
It is read with an Outlook-audience ``Tasks.Read`` token from the same MSAL cache,
so it needs no extra consent.

This module **fails open**: any error — auth, HTTP, a changed shape — returns
``None`` and the display falls back to the title/category/creator rules, exactly
as if the feature were off. It never raises into the sync. See
docs/todo-integration-plan.md.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

SUBSTRATE_BASE = "https://substrate.office.com/todob2/api/v1"
SUBSTRATE_SCOPES = ["https://outlook.office.com/Tasks.Read"]
_MAX_PAGES = 20

# (account, scopes) -> bearer token; raises on failure (any exception fails open).
TokenProvider = Callable[[str, list[str]], str]


@dataclass(frozen=True)
class TaskPeople:
    assignee_name: str | None = None
    created_by_name: str | None = None


class AssignmentReader:
    def __init__(self, client: httpx.Client, token_provider: TokenProvider) -> None:
        self._client = client
        self._token_provider = token_provider
        self._failing: set[str] = set()

    def read(self, account: str, list_id: str) -> dict[str, TaskPeople] | None:
        """Task id -> people for one shared list, or ``None`` if unavailable."""
        try:
            people = self._read(account, list_id)
        except Exception as exc:  # noqa: BLE001 - fail open on anything
            if list_id not in self._failing:
                logger.warning("To Do assignments unavailable for a shared list: %s", exc)
            self._failing.add(list_id)
            return None
        if list_id in self._failing:
            logger.info("To Do assignments available again")
            self._failing.discard(list_id)
        return people

    def _read(self, account: str, list_id: str) -> dict[str, TaskPeople]:
        token = self._token_provider(account, SUBSTRATE_SCOPES)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        folder = f"{SUBSTRATE_BASE}/taskfolders/{quote(list_id, safe='')}"
        names = {
            str(member["Id"]): str(member["DisplayName"])
            for member in self._get(f"{folder}/members", headers)
            if member.get("Id") and member.get("DisplayName")
        }
        result: dict[str, TaskPeople] = {}
        for task in self._get(f"{folder}/tasks", headers):
            if not task.get("Id"):
                continue
            result[str(task["Id"])] = TaskPeople(
                assignee_name=_assignee(task, names),
                created_by_name=_person_name(task.get("CreatedByUser"), names),
            )
        return result

    def _get(self, url: str, headers: dict[str, str]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        next_url: str | None = url
        for _ in range(_MAX_PAGES):
            if not next_url:
                break
            response = self._client.get(next_url, headers=headers)
            response.raise_for_status()
            body = response.json()
            value = body.get("Value", body.get("value"))
            if not isinstance(value, list):
                raise ValueError("unexpected response shape")
            items.extend(item for item in value if isinstance(item, dict))
            next_url = body.get("@odata.nextLink") or body.get("NextLink")
        return items


def _person_name(person: Any, names: dict[str, str]) -> str | None:
    if not isinstance(person, dict):
        return None
    return names.get(str(person.get("Id"))) or person.get("DisplayName") or None


def _assignee(task: dict[str, Any], names: dict[str, str]) -> str | None:
    """The most recent assignment's assignee (To Do allows one per task)."""
    assignments = task.get("Assignments")
    if not isinstance(assignments, list) or not assignments:
        return None
    latest = max(
        (a for a in assignments if isinstance(a, dict)),
        key=lambda a: str(a.get("AssignedDateTime") or ""),
        default=None,
    )
    return _person_name(latest.get("Assignee"), names) if latest else None
