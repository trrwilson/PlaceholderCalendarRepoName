"""The application tools the voice agent may call.

This is the single source of truth for the tool contract, provider-independent.
``TOOL_DECLARATIONS`` is the neutral spec; each provider serialises it into its
own wire shape (``as_gemini_tools`` / ``as_openai_tools``). The serialised tools
are locked into every session grant, and the kiosk mirrors these names in
``frontend/src/voice/tools.ts`` to dispatch each call:

* ``show_view`` / ``focus_date`` / ``highlight_event`` are applied to local view
  state in the browser (no backend, no side effects).
* ``get_events`` / ``get_agenda`` / ``check_conflicts`` are answered by the kiosk
  from ``GET /api/calendar`` — the agent never reaches a calendar provider directly.
* ``start_timer`` / ``cancel_timer`` / ``extend_timer`` / ``get_timer`` drive the
  kitchen timer through ``/api/timers`` — the **only** state-mutating voice tools
  (a narrow, documented exception to the read-only rule: ephemeral, local,
  single-appliance state with no external side effect; calendar writes stay out).

Read-only for the calendar. Event creation/editing is deliberately not here.
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
                "view": {"type": "STRING", "enum": ["home", "week", "month", "timer"]},
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
    {
        "name": "start_timer",
        "description": (
            "Start a single kitchen timer or alarm. Give EITHER a duration "
            "(duration_minutes, e.g. 15 or 0.5) OR an absolute local target time "
            "(fires_at as 'YYYY-MM-DDTHH:MM:SS', no timezone) — for 'set an alarm "
            "for 3pm' or 'thirty minutes before the game' (look the event up "
            "first, then subtract). The limit is six hours from now; anything "
            "longer is rejected. Starting a timer replaces the current one — the "
            "result's replaced_label names what it replaced, mention it if set. "
            "An optional label ('pasta', 'laundry') is shown on the alarm screen."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "duration_minutes": {
                    "type": "NUMBER",
                    "description": "Minutes from now until it fires (accepts fractions).",
                },
                "fires_at": {
                    "type": "STRING",
                    "description": "Local target time 'YYYY-MM-DDTHH:MM:SS' (no offset).",
                },
                "label": {"type": "STRING", "description": "Optional short label."},
            },
        },
    },
    {
        "name": "cancel_timer",
        "description": (
            "Cancel the running timer, or dismiss/stop it when it is going off "
            "('stop', 'dismiss the timer', 'turn it off'). There is one timer."
        ),
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "extend_timer",
        "description": (
            "Add time to the current timer, or snooze it while it is going off "
            "('give me five more minutes'). The new total still cannot exceed six "
            "hours from now."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "add_minutes": {
                    "type": "NUMBER",
                    "description": "Minutes to add (accepts fractions).",
                }
            },
            "required": ["add_minutes"],
        },
    },
    {
        "name": "get_timer",
        "description": "Check whether a timer is running and how much time is left.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
]

TOOL_NAMES: list[str] = [tool["name"] for tool in TOOL_DECLARATIONS]


def as_gemini_tools() -> list[dict[str, Any]]:
    """The tools payload for a Gemini ``LiveConnectConfig``."""
    return [{"function_declarations": TOOL_DECLARATIONS}]


def _to_json_schema(node: Any) -> Any:
    """Lower-case the Gemini-style uppercase ``type`` names for the OpenAI /
    Azure realtime function-tool schema (plain JSON Schema)."""
    if isinstance(node, dict):
        out = {k: _to_json_schema(v) for k, v in node.items()}
        if isinstance(out.get("type"), str):
            out["type"] = out["type"].lower()
        return out
    if isinstance(node, list):
        return [_to_json_schema(item) for item in node]
    return node


def as_openai_tools() -> list[dict[str, Any]]:
    """The ``tools`` array for the OpenAI / Azure realtime protocol.

    Used by the Azure OpenAI Realtime and Azure Voice Live adapters (both speak
    the OpenAI realtime session shape).
    """
    return [
        {
            "type": "function",
            "name": tool["name"],
            "description": tool["description"],
            "parameters": _to_json_schema(tool["parameters"]),
        }
        for tool in TOOL_DECLARATIONS
    ]
