"""Unit tests for the voice system instruction and the schedule digest baked
into it (``app/voice/prompt.py``)."""

from __future__ import annotations

from datetime import datetime, timedelta

from app.models import (
    CalendarColor,
    CalendarEvent,
    CalendarRange,
    CalendarSnapshot,
    HouseholdCalendar,
)
from app.voice.prompt import build_schedule_digest, build_system_instruction

NOW = datetime(2026, 9, 8, 9, 30)
_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _snapshot(events: list[CalendarEvent]) -> CalendarSnapshot:
    return CalendarSnapshot(
        calendars=[
            HouseholdCalendar(
                id="travis", name="trrwilson", display_name="Travis", color=CalendarColor.coral
            ),
            HouseholdCalendar(
                id="sarah", name="sshapro", display_name="Sarah", color=CalendarColor.ocean
            ),
        ],
        events=events,
        range=CalendarRange(starts_on=NOW.date(), ends_on=NOW.date() + timedelta(days=30)),
    )


def _event(
    cal: str,
    title: str,
    start: datetime,
    end: datetime,
    location: str | None = None,
) -> CalendarEvent:
    return CalendarEvent(
        id=f"{cal}-{title}".replace(" ", "-").lower(),
        calendar_id=cal,
        title=title,
        starts_at=start,
        ends_at=end,
        location=location,
    )


def _day_lines(digest: str) -> list[str]:
    return [ln for ln in digest.splitlines() if ln[:3] in _DAYS]


def test_digest_carries_person_title_time_and_location() -> None:
    digest = build_schedule_digest(
        _snapshot(
            [
                _event(
                    "travis",
                    "New patient visit",
                    datetime(2026, 9, 24, 14, 30),
                    datetime(2026, 9, 24, 15, 30),
                    "Overlake Clinic, Bellevue",
                ),
            ]
        ),
        NOW,
    )
    assert "Sep 24" in digest
    assert "Travis — New patient visit 2:30–3:30 PM @ Overlake Clinic, Bellevue" in digest
    # The person is named, not the raw handle.
    assert "trrwilson" not in digest


def test_digest_groups_a_day_and_omits_empty_days() -> None:
    digest = build_schedule_digest(
        _snapshot(
            [
                _event("sarah", "Yoga", datetime(2026, 9, 9, 18), datetime(2026, 9, 9, 19)),
                _event("travis", "Standup", datetime(2026, 9, 9, 9), datetime(2026, 9, 9, 9, 30)),
                _event("sarah", "Brunch", datetime(2026, 9, 20, 11), datetime(2026, 9, 20, 12, 30)),
            ]
        ),
        NOW,
    )
    lines = _day_lines(digest)
    # Two days with events -> two lines; the empty days between are not listed.
    assert len(lines) == 2
    # Events within a day are ordered by start time.
    sep9 = next(ln for ln in lines if "Sep 9" in ln)
    assert sep9.index("Standup") < sep9.index("Yoga")


def test_digest_marks_all_day_and_multi_day_events() -> None:
    digest = build_schedule_digest(
        _snapshot(
            [
                CalendarEvent(
                    id="camp",
                    calendar_id="travis",
                    title="Summer camp",
                    starts_at=datetime(2026, 9, 14, 0, 0),
                    ends_at=datetime(2026, 9, 17, 0, 0),
                    all_day=True,
                ),
            ]
        ),
        NOW,
    )
    assert "Summer camp all day" in digest
    # ends_at is exclusive-midnight Sep 17, so the last busy day is Sep 16.
    assert "through Wed Sep 16" in digest


def test_digest_truncates_a_very_full_window() -> None:
    events = [
        _event(
            "travis",
            f"Event {i}",
            NOW + timedelta(days=i // 3, hours=i % 3),
            NOW + timedelta(days=i // 3, hours=(i % 3) + 1),
        )
        for i in range(20)
    ]
    digest = build_schedule_digest(_snapshot(events), NOW, max_events=5)
    assert "more events beyond here" in digest


def test_digest_handles_an_empty_window() -> None:
    assert "Nothing" in build_schedule_digest(_snapshot([]), NOW)


def test_system_instruction_forbids_follow_up_questions() -> None:
    text = build_system_instruction(NOW, ["Travis", "Sarah"], "America/Los_Angeles")
    assert "one self-contained exchange" in text
    assert "Do NOT tack on a follow-up" in text
    assert "Would you like" in text  # the phrasing it must avoid is spelled out


def test_system_instruction_tells_the_model_to_match_title_and_location() -> None:
    text = build_system_instruction(
        NOW,
        ["Travis"],
        None,
        schedule="Sep 24: Travis — New patient visit 2:30 PM @ Bellevue",
    )
    assert "against BOTH the title and the location" in text
    assert "New patient visit 2:30 PM @ Bellevue" in text


def test_system_instruction_without_a_schedule_says_so() -> None:
    text = build_system_instruction(NOW, ["Travis"], None)
    assert "not loaded right now" in text


def test_system_instruction_treats_the_wake_phrase_as_address_not_content() -> None:
    text = build_system_instruction(NOW, ["Travis"], None)
    assert '"Mission Control" to get your attention' in text
    assert "not part of their question" in text
