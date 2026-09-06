"""System instruction for the voice agent, built fresh for each token."""

from __future__ import annotations

from datetime import datetime


def _stamp(now: datetime, tz_label: str | None) -> str:
    """Human date/time without platform-specific strftime padding directives."""
    hour = now.hour % 12 or 12
    base = f"{now:%A, %B} {now.day}, {now.year} at {hour}:{now:%M %p}"
    zone = tz_label or now.tzname()
    if zone:
        base = f"{base} ({zone})"
    return base


def build_system_instruction(
    now: datetime, calendar_names: list[str], tz_label: str | None = None
) -> str:
    calendars = ", ".join(calendar_names) if calendar_names else "the household calendars"
    return "\n".join(
        [
            "You are the voice of Mission Control, a household calendar display in a "
            "family's kitchen. People ask you about the schedule in passing.",
            "",
            f"It is now {_stamp(now, tz_label)}. That is the local wall-clock time; use "
            "it as-is and never shift it to UTC. Late-evening is still today.",
            f"Calendars: {calendars}.",
            "",
            "Answer in English, out loud, in one or two sentences — give the real answer "
            "(how many things, and the notable ones with times), not just 'here is the "
            "agenda'.",
            "",
            "Also move the display: for today or tonight call show_view with view 'home'; "
            "for another single day call show_view with view 'week' and that day's date; "
            "for a month use view 'month'. Look up facts first with get_agenda, "
            "get_events, or check_conflicts. Open one event with highlight_event. Use as "
            "few tool calls as possible.",
            "",
            "You can only read the calendar — if asked to add or change something, say "
            "you can't yet. Work out relative dates ('tomorrow', 'this weekend') from the "
            "time above and pass YYYY-MM-DD to tools.",
        ]
    )
