from datetime import date, datetime, time, timedelta
from typing import Protocol
from uuid import uuid4

from app.models import (
    CalendarColor,
    CalendarEvent,
    CalendarRange,
    CalendarSnapshot,
    EventCategory,
    HouseholdCalendar,
)


class CalendarProvider(Protocol):
    def snapshot(self, calendar_range: CalendarRange) -> CalendarSnapshot: ...

    def create_event(self, event: CalendarEvent) -> CalendarEvent: ...


class MockCalendarProvider:
    def __init__(self, today: date | None = None) -> None:
        self.today = today or date.today()
        self.calendars = [
            HouseholdCalendar(id="family", name="Family", color=CalendarColor.coral),
            HouseholdCalendar(id="alex", name="Alex", color=CalendarColor.ocean),
            HouseholdCalendar(id="jordan", name="Jordan", color=CalendarColor.gold),
            HouseholdCalendar(id="home", name="Home", color=CalendarColor.fern),
        ]
        self.events = self._seed_events()

    def snapshot(self, calendar_range: CalendarRange) -> CalendarSnapshot:
        start = datetime.combine(calendar_range.starts_on, time.min)
        end = datetime.combine(calendar_range.ends_on + timedelta(days=1), time.min)
        events = [event for event in self.events if event.starts_at < end and event.ends_at > start]
        events.sort(key=lambda event: (event.starts_at, event.ends_at, event.title))
        return CalendarSnapshot(calendars=self.calendars, events=events, range=calendar_range)

    def create_event(self, event: CalendarEvent) -> CalendarEvent:
        self.events.append(event.model_copy(update={"id": event.id or str(uuid4())}))
        return self.events[-1]

    def _seed_events(self) -> list[CalendarEvent]:
        today = self.today

        def at(day_offset: int, hour: int, minute: int = 0) -> datetime:
            return datetime.combine(today + timedelta(days=day_offset), time(hour, minute))

        def event(
            event_id: str,
            calendar_id: str,
            title: str,
            start: datetime,
            end: datetime,
            location: str | None = None,
            categories: list[EventCategory] | None = None,
        ) -> CalendarEvent:
            return CalendarEvent(
                id=event_id,
                calendar_id=calendar_id,
                title=title,
                starts_at=start,
                ends_at=end,
                location=location,
                categories=categories or [],
            )

        school = EventCategory(id="school", name="School", color="#2d9cdb")
        work = EventCategory(id="work", name="Work", color="#16a085")
        sports = EventCategory(id="sports", name="Sports", color="#27ae60")
        medical = EventCategory(id="medical", name="Medical", color="#e74c3c")
        birthday = EventCategory(id="birthday", name="Birthday", color="#c2185b")

        return [
            event(
                "school-dropoff",
                "family",
                "School drop-off",
                at(0, 7, 45),
                at(0, 8, 15),
                categories=[school],
            ),
            event(
                "standup", "alex", "Product stand-up", at(0, 9), at(0, 9, 30), "Study nook", [work]
            ),
            event(
                "swim",
                "jordan",
                "Swim practice",
                at(0, 16),
                at(0, 17, 15),
                "Riverside pool",
                [sports],
            ),
            event("dinner", "home", "Taco night", at(0, 18, 30), at(0, 20)),
            event(
                "dentist",
                "jordan",
                "Dentist appointment",
                at(1, 10),
                at(1, 11),
                "Cedar Street Dental",
                [medical],
            ),
            event(
                "library",
                "family",
                "Return library books",
                at(2, 15),
                at(2, 15, 45),
                "Main library",
                [school],
            ),
            event(
                "soccer",
                "jordan",
                "Soccer match",
                at(3, 9),
                at(3, 10, 30),
                "North field",
                [sports, EventCategory(id="school", name="School", color="#2d9cdb")],
            ),
            CalendarEvent(
                id="camp",
                calendar_id="family",
                title="School break",
                starts_at=at(5, 0),
                ends_at=at(8, 0),
                all_day=True,
                categories=[school],
            ),
            event("groceries", "home", "Grocery run", at(6, 11), at(6, 12)),
            CalendarEvent(
                id="birthday",
                calendar_id="family",
                title="Mia's birthday",
                starts_at=at(10, 0),
                ends_at=at(11, 0),
                all_day=True,
                categories=[birthday],
            ),
        ]
