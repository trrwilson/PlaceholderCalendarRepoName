from datetime import UTC, date, datetime

import httpx
import pytest
import respx

from app.calendar.graph import _LOCAL_TZ, MicrosoftGraphCalendarProvider
from app.config import Settings
from app.models import CalendarRange, CalendarSnapshot

TOKEN_URL = "https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token"
PROFILE_URL = "https://graph.microsoft.com/v1.0/users/alex@example.com"
CALENDAR_VIEW = "https://graph.microsoft.com/v1.0/users/alex@example.com/calendarView"
EVENTS_URL = "https://graph.microsoft.com/v1.0/users/alex@example.com/events"
# The non-primary-calendar listing every snapshot() now makes alongside the
# primary calendarView (see app/calendar/secondary.py) — mocked empty by
# default so existing tests are unaffected by it.
CALENDARS_URL = "https://graph.microsoft.com/v1.0/users/alex@example.com/calendars"
NO_EXTRA_CALENDARS = httpx.Response(200, json={"value": []})
MASTER_CATEGORIES = (
    "https://graph.microsoft.com/v1.0/users/alex@example.com/outlook/masterCategories"
)


def make_settings(**overrides: object) -> Settings:
    base: dict[str, object] = {
        "calendar_provider": "graph",
        "graph_tenant_id": "test-tenant",
        "graph_client_id": "test-client",
        "graph_client_secret": "test-secret",
        "graph_calendar_users": ["alex@example.com"],
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


def token_response() -> httpx.Response:
    return httpx.Response(200, json={"access_token": "tok-123", "expires_in": 3600})


def timed_event(**overrides: object) -> dict[str, object]:
    event = {
        "id": "evt-timed",
        "subject": "Product stand-up",
        "start": {"dateTime": "2026-09-05T09:00:00.0000000", "timeZone": "UTC"},
        "end": {"dateTime": "2026-09-05T09:30:00.0000000", "timeZone": "UTC"},
        "isAllDay": False,
        "location": {"displayName": "Study nook"},
        "categories": [],
    }
    event.update(overrides)
    return event


# --- auth -----------------------------------------------------------------


@respx.mock
def test_token_is_acquired_and_cached() -> None:
    token_route = respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())

    assert provider._access_token() == "tok-123"
    assert provider._access_token() == "tok-123"
    assert token_route.call_count == 1


def test_missing_credentials_raises_runtime_error() -> None:
    with pytest.raises(RuntimeError, match="GRAPH_CLIENT_SECRET"):
        MicrosoftGraphCalendarProvider(make_settings(graph_client_secret=None))

    with pytest.raises(RuntimeError, match="GRAPH_CALENDAR_USERS"):
        MicrosoftGraphCalendarProvider(make_settings(graph_calendar_users=[]))


# --- mapping ------------------------------------------------------------------


@respx.mock
def test_maps_timed_event_to_domain() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(return_value=httpx.Response(200, json={"value": [timed_event()]}))

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (event,) = snapshot.events
    assert event.id == "evt-timed"
    assert event.calendar_id == "alex@example.com"
    assert event.title == "Product stand-up"
    assert event.location == "Study nook"
    assert event.all_day is False
    expected = datetime(2026, 9, 5, 9, 0, tzinfo=UTC).astimezone(_LOCAL_TZ).replace(tzinfo=None)
    assert event.starts_at == expected
    assert event.starts_at.tzinfo is None


@respx.mock
def test_tz_aware_datetime_is_converted_to_naive_local() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    raw = timed_event(
        start={"dateTime": "2026-09-05T14:30:00+00:00", "timeZone": "UTC"},
        end={"dateTime": "2026-09-05T15:00:00+00:00", "timeZone": "UTC"},
    )
    respx.get(CALENDAR_VIEW).mock(return_value=httpx.Response(200, json={"value": [raw]}))

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (event,) = snapshot.events
    expected = datetime(2026, 9, 5, 14, 30, tzinfo=UTC).astimezone(_LOCAL_TZ).replace(tzinfo=None)
    assert event.starts_at == expected


@respx.mock
def test_maps_all_day_event_with_midnight_boundaries() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    raw = {
        "id": "evt-allday",
        "subject": "School break",
        "start": {"dateTime": "2026-09-07T00:00:00.0000000", "timeZone": "UTC"},
        "end": {"dateTime": "2026-09-10T00:00:00.0000000", "timeZone": "UTC"},
        "isAllDay": True,
        "location": None,
        "categories": [],
    }
    respx.get(CALENDAR_VIEW).mock(return_value=httpx.Response(200, json={"value": [raw]}))

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 7), ends_on=date(2026, 9, 10))
    )

    (event,) = snapshot.events
    assert event.all_day is True
    assert event.starts_at == datetime(2026, 9, 7, 0, 0)
    assert event.ends_at == datetime(2026, 9, 10, 0, 0)
    assert event.location is None


@respx.mock
def test_empty_subject_is_coalesced() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(
        return_value=httpx.Response(200, json={"value": [timed_event(subject="")]})
    )

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (event,) = snapshot.events
    assert event.title == "(no title)"


def _master_categories(**names_to_presets: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "value": [
                {"id": name, "displayName": name, "color": preset}
                for name, preset in names_to_presets.items()
            ]
        },
    )


@respx.mock
def test_maps_categories_with_slugified_ids_and_master_colors() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(
        return_value=httpx.Response(
            200, json={"value": [timed_event(categories=["Sports", "Work Travel"])]}
        )
    )
    master = respx.get(MASTER_CATEGORIES).mock(
        return_value=_master_categories(Sports="preset4", **{"Work Travel": "preset7"})
    )

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (event,) = snapshot.events
    assert [(c.id, c.name, c.color) for c in event.categories] == [
        ("sports", "Sports", "#27ae60"),
        ("work-travel", "Work Travel", "#2d9cdb"),
    ]
    assert master.called


@respx.mock
def test_category_missing_from_master_list_falls_back_to_neutral() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(
        return_value=httpx.Response(200, json={"value": [timed_event(categories=["Mystery"])]})
    )
    respx.get(MASTER_CATEGORIES).mock(return_value=_master_categories(Sports="preset4"))

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (event,) = snapshot.events
    assert event.categories[0].color == "#6e8596"


@respx.mock
def test_master_categories_fetched_once_and_reused() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(
        return_value=httpx.Response(200, json={"value": [timed_event(categories=["Sports"])]})
    )
    master = respx.get(MASTER_CATEGORIES).mock(return_value=_master_categories(Sports="preset4"))

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    window = CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    provider.snapshot(window)
    provider.snapshot(window)

    assert master.call_count == 1


@respx.mock
def test_snapshot_without_categories_skips_master_categories_fetch() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(return_value=httpx.Response(200, json={"value": [timed_event()]}))
    master = respx.get(MASTER_CATEGORIES).mock(return_value=_master_categories())

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    provider.snapshot(CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5)))

    assert not master.called


@respx.mock
def test_pagination_follows_next_link() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    page1 = {
        "value": [timed_event(id="evt-1")],
        "@odata.nextLink": CALENDAR_VIEW + "?%24skiptoken=abc",
    }
    page2 = {"value": [timed_event(id="evt-2")]}
    respx.get(CALENDAR_VIEW).mock(
        side_effect=[
            httpx.Response(200, json=page1),
            httpx.Response(200, json=page2),
        ]
    )

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    assert {event.id for event in snapshot.events} == {"evt-1", "evt-2"}


# --- snapshot ---------------------------------------------------------------


@respx.mock
def test_snapshot_returns_valid_snapshot_across_users() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(
        return_value=httpx.Response(200, json={"value": [timed_event(id="evt-a")]})
    )
    respx.get("https://graph.microsoft.com/v1.0/users/jordan@example.com/calendarView").mock(
        return_value=httpx.Response(
            200,
            json={
                "value": [
                    {
                        "id": "evt-b",
                        "subject": "Swim practice",
                        "start": {
                            "dateTime": "2026-09-05T07:00:00.0000000",
                            "timeZone": "UTC",
                        },
                        "end": {
                            "dateTime": "2026-09-05T08:00:00.0000000",
                            "timeZone": "UTC",
                        },
                        "isAllDay": False,
                        "categories": [],
                    }
                ]
            },
        )
    )

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    respx.get("https://graph.microsoft.com/v1.0/users/jordan@example.com/calendars").mock(
        return_value=NO_EXTRA_CALENDARS
    )
    provider = MicrosoftGraphCalendarProvider(
        make_settings(graph_calendar_users=["alex@example.com", "jordan@example.com"])
    )
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    assert isinstance(snapshot, CalendarSnapshot)
    assert [c.id for c in snapshot.calendars] == ["alex@example.com", "jordan@example.com"]
    assert len({c.color for c in snapshot.calendars}) == 2
    assert [event.id for event in snapshot.events] == ["evt-b", "evt-a"]
    assert {event.calendar_id for event in snapshot.events} == {
        "alex@example.com",
        "jordan@example.com",
    }


@respx.mock
def test_household_calendar_uses_the_holders_given_name_and_outlook_source() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(return_value=httpx.Response(200, json={"value": [timed_event()]}))
    profile = respx.get(PROFILE_URL).mock(
        return_value=httpx.Response(200, json={"givenName": "Alex", "displayName": "Alex Rivera"})
    )

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (calendar,) = snapshot.calendars
    assert calendar.name == "alex"
    assert calendar.display_name == "Alex"
    assert calendar.source == "outlook"
    assert profile.called


@respx.mock
def test_household_calendar_falls_back_to_account_name_without_directory_access() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    respx.get(CALENDAR_VIEW).mock(return_value=httpx.Response(200, json={"value": [timed_event()]}))
    respx.get(PROFILE_URL).mock(return_value=httpx.Response(403, json={"error": "Denied"}))

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (calendar,) = snapshot.calendars
    assert calendar.display_name == "alex"


@respx.mock
def test_create_event_posts_to_graph() -> None:
    respx.post(TOKEN_URL).mock(return_value=token_response())
    captured: dict[str, object] = {}

    def _respond(request: httpx.Request) -> httpx.Response:
        import json

        captured.update(json.loads(request.content))
        return httpx.Response(
            201,
            json={
                "id": "evt-new",
                "subject": "Taco night",
                "start": {"dateTime": "2026-09-05T18:30:00.0000000", "timeZone": "UTC"},
                "end": {"dateTime": "2026-09-05T20:00:00.0000000", "timeZone": "UTC"},
                "isAllDay": False,
                "categories": [],
            },
        )

    respx.post(EVENTS_URL).mock(side_effect=_respond)

    respx.get(CALENDARS_URL).mock(return_value=NO_EXTRA_CALENDARS)
    provider = MicrosoftGraphCalendarProvider(make_settings())
    from app.models import CalendarEvent

    created = provider.create_event(
        CalendarEvent(
            id="ignored",
            calendar_id="alex@example.com",
            title="Taco night",
            starts_at=datetime(2026, 9, 5, 18, 30),
            ends_at=datetime(2026, 9, 5, 20, 0),
        )
    )

    assert created.id == "evt-new"
    assert captured["subject"] == "Taco night"
