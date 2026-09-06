"""The application tools the voice agent may call.

This is the single source of truth for the tool contract. The declarations are
locked into every ephemeral token, and the kiosk mirrors these names in
``frontend/src/voice/tools.ts`` to dispatch each call:

* ``show_view`` / ``focus_date`` / ``highlight_event`` are applied to local view
  state in the browser (no backend, no side effects).
* ``get_events`` / ``get_agenda`` / ``check_conflicts`` are answered by the kiosk
  from ``GET /api/calendar`` — the agent never reaches a calendar provider directly.

Read-only by design. Event creation/editing is deliberately not here yet.
"""

from __future__ import annotations

from typing import Any

_DATE = {"type": "STRING", "description": "Calendar date as ISO 8601 YYYY-MM-DD."}

TOOL_DECLARATIONS: list[dict[str, Any]] = [
    {
        "name": "show_view",
        "description": (
            "Switch the dashboard to the Home (today + next up), Week, or Month "
            "view. Use this to *show* the household an answer rather than only "
            "speaking it. Optionally focus a specific date."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "view": {"type": "STRING", "enum": ["home", "week", "month"]},
                "date": _DATE,
            },
            "required": ["view"],
        },
    },
    {
        "name": "focus_date",
        "description": (
            "Move the currently visible view to a date (e.g. 'show me Friday', "
            "'go to next week') without changing which view is active."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {"date": _DATE},
            "required": ["date"],
        },
    },
    {
        "name": "highlight_event",
        "description": (
            "Select and open the detail sheet for the event that best matches a "
            "short description, so the household can see its full details."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "A few words from the event title or the person.",
                }
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_events",
        "description": (
            "Read household calendar events between two dates (inclusive). Returns "
            "titles, times, calendar/person, and location."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {"start": _DATE, "end": _DATE},
            "required": ["start", "end"],
        },
    },
    {
        "name": "get_agenda",
        "description": "Read the chronological list of events for a single day.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"date": _DATE},
            "required": ["date"],
        },
    },
    {
        "name": "check_conflicts",
        "description": (
            "Check a single day for overlapping events across household calendars "
            "and return any clashing pairs."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {"date": _DATE},
            "required": ["date"],
        },
    },
]

TOOL_NAMES: list[str] = [tool["name"] for tool in TOOL_DECLARATIONS]


def build_tools() -> list[dict[str, Any]]:
    """Return the tools payload for a ``LiveConnectConfig``."""
    return [{"function_declarations": TOOL_DECLARATIONS}]
