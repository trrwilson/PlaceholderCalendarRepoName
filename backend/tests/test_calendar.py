from datetime import date, datetime, time, timedelta

import pytest
from pydantic import ValidationError

from app.calendar.provider import MockCalendarProvider
from app.models import CalendarEvent, CalendarRange


def test_snapshot_filters_events_to_requested_range() -> None:
    provider = MockCalendarProvider(date(2026, 9, 5))
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    assert {event.id for event in snapshot.events} == {
        "school-dropoff",
        "standup",
        "swim",
        "dinner",
    }


def test_mock_provider_has_distinct_calendars_and_overlapping_events() -> None:
    provider = MockCalendarProvider(date(2026, 9, 5))
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 15))
    )

    primary = [calendar for calendar in snapshot.calendars if calendar.is_primary]
    assert len(primary) == 4
    assert len({calendar.color for calendar in primary}) == 4
    assert any(event.all_day for event in snapshot.events)
    # The mock has no real accounts: display name mirrors the label, no provider badge.
    assert all(calendar.display_name == calendar.name for calendar in snapshot.calendars)
    assert {calendar.source for calendar in snapshot.calendars} == {"mock"}


def test_mock_provider_lists_a_non_primary_calendar_disabled_by_default() -> None:
    provider = MockCalendarProvider(date(2026, 9, 5))
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 15))
    )

    extra = next(calendar for calendar in snapshot.calendars if calendar.id == "family::holidays")
    assert extra.is_primary is False
    assert extra.enabled is False
    assert extra.account_id == "family"
    assert "labor-day" not in {event.id for event in snapshot.events}

    provider.set_calendar_enabled("family::holidays", True)
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 15))
    )
    assert "labor-day" in {event.id for event in snapshot.events}

    with pytest.raises(ValueError):
        provider.set_calendar_enabled("family", False)


def test_mock_events_preserve_category_classification_separately_from_calendar_identity() -> None:
    provider = MockCalendarProvider(date(2026, 9, 5))
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 15))
    )
    events = {event.id: event for event in snapshot.events}

    assert events["dinner"].categories == []
    assert [category.name for category in events["swim"].categories] == ["Sports"]
    assert {category.name for category in events["soccer"].categories} == {"Sports", "School"}
    assert events["swim"].calendar_id == "jordan"
    category_color = events["swim"].categories[0].color
    assert category_color != events["swim"].calendar_id
    assert category_color.startswith("#") and len(category_color) == 7


def test_event_rejects_invalid_time_order() -> None:
    with pytest.raises(ValidationError):
        CalendarEvent(
            id="bad",
            calendar_id="family",
            title="Impossible",
            starts_at=datetime.combine(date.today(), time(12)),
            ends_at=datetime.combine(date.today(), time(11)),
        )


def test_range_rejects_reversed_dates() -> None:
    with pytest.raises(ValidationError):
        CalendarRange(starts_on=date.today(), ends_on=date.today() - timedelta(days=1))
