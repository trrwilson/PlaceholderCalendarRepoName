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

    assert len(snapshot.calendars) == 4
    assert len({calendar.color for calendar in snapshot.calendars}) == 4
    assert any(event.all_day for event in snapshot.events)


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
