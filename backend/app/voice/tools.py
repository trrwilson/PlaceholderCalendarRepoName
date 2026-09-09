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
* ``start_timer`` / ``cancel_timer`` / ``extend_timer`` / ``pause_timer`` /
  ``resume_timer`` / ``restart_timer`` / ``get_timer`` drive the kitchen timer
  through ``/api/timers``.
* ``add_to_list`` / ``remove_from_list`` / ``check_off_item`` / ``clear_list`` /
  ``get_list`` manage the household grocery list through ``/api/lists``.
* ``enter_privacy_mode`` / ``request_privacy_unlock`` turn on the houseguest
  privacy mode and summon the on-screen unlock keypad (``/api/privacy``). The
  assistant can only *enter* privacy mode and *ask* for the keypad — it can never
  turn privacy mode off (that needs the PIN typed on screen).
* ``set_night_mode`` dims the physical wall panel to ~10% (or restores it)
  through ``/api/display`` — the backend owns real brightness; the browser
  cannot. Inert unless the backend is colocated with the kiosk
  (``docs/display-dimming-plan.md``).

The timer and list tools are the state-mutating voice tools — a narrow,
documented exception to the read-only rule: local, single-household appliance
state with no external side effect. **Calendar writes stay out.** While privacy
mode is on, the kiosk refuses every tool except ``request_privacy_unlock``.
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
        "name": "set_people_filter",
        "description": (
            "Change which household members' calendars are shown. mode 'only' "
            "shows just the named people (e.g. 'show Sarah's calendar'), 'add' / "
            "'remove' adjust the current selection, 'all' clears the filter and "
            "shows everyone. Names are matched to the household loosely. This is "
            "view state only — it does not change any calendar."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "mode": {"type": "STRING", "enum": ["only", "add", "remove", "all"]},
                "people": {
                    "type": "ARRAY",
                    "items": {"type": "STRING"},
                    "description": "Person names or household-calendar ids; empty for mode 'all'.",
                },
            },
            "required": ["mode"],
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
        "name": "pause_timer",
        "description": (
            "Pause the running timer, holding the time that is left until it is "
            "resumed ('pause the timer', 'hold the timer')."
        ),
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "resume_timer",
        "description": (
            "Resume a paused timer so it keeps counting down from where it "
            "stopped ('resume', 'unpause', 'keep the timer going')."
        ),
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "restart_timer",
        "description": (
            "Restart the current timer from its original full duration ('restart "
            "the timer', 'start it over', 'reset the timer'). Works while it is "
            "running, paused, or going off."
        ),
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "get_timer",
        "description": "Check whether a timer is running and how much time is left.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "add_to_list",
        "description": (
            "Add one or more items to the household grocery list ('add milk', "
            "'put eggs, bread and butter on the list'). Split a spoken list of "
            "things into separate items. Adding something already on the list is "
            "fine — say it was already there; if it was checked off, this puts it "
            "back. There is one list (grocery); 'list' defaults to it."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "items": {
                    "type": "ARRAY",
                    "items": {"type": "STRING"},
                    "description": "Item names, one per entry.",
                },
                "list": {"type": "STRING", "description": "List name; defaults to 'grocery'."},
            },
            "required": ["items"],
        },
    },
    {
        "name": "remove_from_list",
        "description": (
            "Take a single item off the grocery list entirely ('take milk off "
            "the list', 'remove the bread'). This deletes it — use check_off_item "
            "for 'I got the milk'. If nothing matches, say so."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "item": {"type": "STRING", "description": "A few words of the item name."},
                "list": {"type": "STRING", "description": "List name; defaults to 'grocery'."},
            },
            "required": ["item"],
        },
    },
    {
        "name": "check_off_item",
        "description": (
            "Mark one grocery item as bought ('check off the milk', 'I got the "
            "eggs') — it stays on the list, struck through, until the list is "
            "cleared. If nothing matches, say so."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "item": {"type": "STRING", "description": "A few words of the item name."},
                "list": {"type": "STRING", "description": "List name; defaults to 'grocery'."},
            },
            "required": ["item"],
        },
    },
    {
        "name": "clear_list",
        "description": (
            "Clear the grocery list. scope 'all' removes everything ('clear the "
            "grocery list' — the default), scope 'checked' removes only the "
            "items already checked off ('clear the ones we got'). Tell the "
            "household they can say nothing to undo it — the screen shows an "
            "Undo for a few seconds."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "scope": {"type": "STRING", "enum": ["all", "checked"]},
                "list": {"type": "STRING", "description": "List name; defaults to 'grocery'."},
            },
        },
    },
    {
        "name": "get_list",
        "description": (
            "Read what is on the grocery list right now (item names and whether "
            "each is checked off)."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "list": {"type": "STRING", "description": "List name; defaults to 'grocery'."},
            },
        },
    },
    {
        "name": "enter_privacy_mode",
        "description": (
            "Turn on privacy mode: the display hides event and list details for a "
            "visitor and goes read-only. Use when asked to 'hide the calendar', "
            "'someone's coming over', 'privacy mode on'. It takes the PIN on the "
            "screen to turn off again — say so."
        ),
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "request_privacy_unlock",
        "description": (
            "Bring up the PIN keypad so someone can turn OFF privacy mode ('turn "
            "off privacy mode', 'exit privacy mode', 'unlock the display'). You "
            "cannot turn it off yourself — they must enter the PIN on screen. "
            "While privacy mode is on this is the only thing you can do; decline "
            "everything else politely."
        ),
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "set_night_mode",
        "description": (
            "Turn the wall display's night mode on or off. On ('night mode', "
            "'dim the screen for the night', 'it's too bright') drops the panel "
            "to about a tenth of its current brightness; off ('day mode', 'turn "
            "off night mode', 'bring the screen back up') restores the brightness "
            "it had before. Confirm in one short sentence."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "on": {
                    "type": "BOOLEAN",
                    "description": "true to dim for night, false to restore.",
                }
            },
            "required": ["on"],
        },
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
