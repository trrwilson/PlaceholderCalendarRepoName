"""Live check of the Microsoft To Do assumptions in docs/todo-integration-plan.md.

Hardware/live only — never run in CI. Uses the same MSAL client + token cache as
the personal-Outlook calendar (``MISSION_CONTROL_GRAPH_*`` settings) and prints
what it finds for each [verify] item, read-only:

    cd backend
    python -m scripts.validate_todo_graph            # all signed-in accounts
    python -m scripts.validate_todo_graph --resume   # reuse saved delta links

A member who signed in before To Do was enabled must sign in again (from the
kiosk, with MISSION_CONTROL_TODO_ENABLED=true and TODO_PROVIDER=graph) so the
cache holds a Tasks.Read grant. Delta links are kept in
``todo_validate_links.json`` (git-ignored) so a later ``--resume`` run measures
how long a link survives before Graph answers 410 Gone.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import httpx

from app.calendar.graph import _GRAPH_BASE, CategoryColorCache
from app.calendar.outlook_personal import save_cache, shared_msal_app
from app.config import get_settings

LINKS = Path("todo_validate_links.json")


def token(app, cache, path, account, scopes) -> str | None:
    result = app.acquire_token_silent(scopes, account=account)
    save_cache(cache, path)
    return result.get("access_token") if result else None


def follow(client: httpx.Client, url: str, headers: dict) -> tuple[list[dict], str | None, int]:
    items: list[dict] = []
    while url:
        response = client.get(url, headers=headers)
        if response.status_code != 200:
            print(f"    HTTP {response.status_code}: {response.text[:300]}")
            return items, None, response.status_code
        body = response.json()
        items.extend(body.get("value", []))
        if "@odata.deltaLink" in body:
            return items, body["@odata.deltaLink"], 200
        url = body.get("@odata.nextLink")
    return items, None, 200


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true", help="re-use saved delta links")
    args = parser.parse_args()
    settings = get_settings()
    app, cache, path = shared_msal_app(settings)
    client = httpx.Client(timeout=30)
    saved = json.loads(LINKS.read_text()) if LINKS.exists() else {}
    accounts = app.get_accounts()
    if not accounts:
        print("No signed-in accounts. Sign in from the kiosk first.")
        return 1

    for account in accounts:
        name = account.get("username")
        print(f"\n== {name}")
        tasks_token = token(app, cache, path, account, ["Tasks.Read"])
        print(f"  [consent] Tasks.Read token: {'yes' if tasks_token else 'NO, sign in again'}")
        if not tasks_token:
            continue
        headers = {"Authorization": f"Bearer {tasks_token}"}

        if args.resume and name in saved:
            print(f"  [delta lifetime] resuming links saved at {saved[name]['saved_at']}")
            for list_id, link in saved[name]["tasks"].items():
                items, _next, status = follow(client, link, headers)
                print(f"    list {list_id[:12]}…: HTTP {status}, {len(items)} change(s)")
            continue

        lists, lists_link, _ = follow(client, f"{_GRAPH_BASE}/me/todo/lists/delta", headers)
        print(f"  [lists] {len(lists)} list(s); lists/delta link: {'yes' if lists_link else 'no'}")
        record = {"saved_at": datetime.now().isoformat(), "tasks": {}}
        all_categories: set[str] = set()
        for raw in lists:
            print(
                f"    - {raw.get('displayName')!r} id={raw.get('id', '')[:16]}… "
                f"isOwner={raw.get('isOwner')} isShared={raw.get('isShared')} "
                f"wellknown={raw.get('wellknownListName')}"
            )
            url = f"{_GRAPH_BASE}/me/todo/lists/{quote(raw['id'], safe='')}/tasks/delta"
            tasks, link, _ = follow(client, url, headers)
            if link:
                record["tasks"][raw["id"]] = link
            for task in tasks[:5]:
                print(
                    f"        task {task.get('title')!r}: dueDateTime={task.get('dueDateTime')} "
                    f"status={task.get('status')} categories={task.get('categories')} "
                    f"checklistItems in delta={'checklistItems' in task}"
                )
            for task in tasks:
                all_categories.update(task.get("categories") or [])
        saved[name] = record

        # $select honoured on delta? (a narrow select should drop 'body')
        probe = lists[0]["id"] if lists else None
        if probe:
            r = client.get(
                f"{_GRAPH_BASE}/me/todo/lists/{quote(probe, safe='')}/tasks/delta",
                params={"$select": "id,title"},
                headers=headers,
            )
            sample = (r.json().get("value") or [{}])[0] if r.status_code == 200 else {}
            print(f"  [$select on delta] HTTP {r.status_code}; keys={sorted(sample)[:8]}")
            pref = client.get(
                f"{_GRAPH_BASE}/me/todo/lists/{quote(probe, safe='')}/tasks",
                headers={**headers, "Prefer": 'outlook.timezone="Pacific Standard Time"'},
            )
            first = next((t for t in pref.json().get("value", []) if t.get("dueDateTime")), None)
            print(f"  [Prefer timezone] dueDateTime: {first and first['dueDateTime']}")

        cal_token = token(app, cache, path, account, ["Calendars.Read"])
        if cal_token and all_categories:
            colors = CategoryColorCache(client).get(
                f"{_GRAPH_BASE}/me", {"Authorization": f"Bearer {cal_token}"}, name
            )
            for category in sorted(all_categories):
                print(
                    f"  [category] {category!r} -> {colors.get(category.casefold(), 'NOT MASTER')}"
                )
        elif not all_categories:
            print("  [category] no task carries a category")

    LINKS.write_text(json.dumps(saved, indent=2))
    print(f"\nSaved delta links to {LINKS} — run again later with --resume.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
