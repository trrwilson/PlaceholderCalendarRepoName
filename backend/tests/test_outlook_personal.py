from datetime import UTC, date, datetime

import httpx
import pytest
import respx

from app.calendar.graph import _LOCAL_TZ
from app.calendar.outlook_personal import PersonalOutlookCalendarProvider, load_msal_app, save_cache
from app.config import Settings
from app.models import CalendarEvent, CalendarRange, CalendarSnapshot

CALENDAR_VIEW = "https://graph.microsoft.com/v1.0/me/calendarView"
MASTER_CATEGORIES = "https://graph.microsoft.com/v1.0/me/outlook/masterCategories"


def make_settings(tmp_path, **overrides: object) -> Settings:
    base: dict[str, object] = {
        "calendar_provider": "outlook_personal",
        "graph_client_id": "test-client",
        "graph_token_cache": str(tmp_path / "cache.json"),
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


def timed_event(**overrides: object) -> dict[str, object]:
    event = {
        "id": "evt-1",
        "subject": "Product stand-up",
        "start": {"dateTime": "2026-09-05T09:00:00.0000000", "timeZone": "UTC"},
        "end": {"dateTime": "2026-09-05T09:30:00.0000000", "timeZone": "UTC"},
        "isAllDay": False,
        "location": {"displayName": "Study nook"},
        "categories": [],
    }
    event.update(overrides)
    return event


def build_provider(tmp_path, **overrides: object) -> PersonalOutlookCalendarProvider:
    return PersonalOutlookCalendarProvider(
        make_settings(tmp_path, **overrides),
        token_provider=lambda: "tok-123",
    )


# --- configuration / auth -------------------------------------------------------


def test_missing_client_id_falls_back_to_public_device_client(tmp_path) -> None:
    from app.calendar.outlook_personal import DEFAULT_DEVICE_CLIENT_ID

    provider = PersonalOutlookCalendarProvider(make_settings(tmp_path, graph_client_id=None))
    assert provider._app is not None
    assert provider._app.client_id == DEFAULT_DEVICE_CLIENT_ID


def test_not_signed_in_raises_with_login_hint(tmp_path) -> None:
    provider = PersonalOutlookCalendarProvider(make_settings(tmp_path))
    with pytest.raises(RuntimeError, match="not signed in"):
        provider.snapshot(CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5)))


def test_load_msal_app_round_trips_the_cache(tmp_path) -> None:
    settings = make_settings(tmp_path)
    _app, cache, path = load_msal_app(settings)
    cache.add(
        {
            "client_id": "test-client",
            "scope": ["Calendars.Read"],
            "token_endpoint": "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
            "response": {
                "access_token": "x",
                "refresh_token": "y",
                "id_token": "",
                "token_type": "Bearer",
                "expires_in": 3600,
            },
        }
    )
    save_cache(cache, path)
    assert path.exists()

    _app2, cache2, _ = load_msal_app(settings)
    assert list(cache2.search(cache2.CredentialType.REFRESH_TOKEN))


# --- mapping ------------------------------------------------------------------


@respx.mock
def test_maps_me_calendar_view_to_snapshot(tmp_path) -> None:
    respx.get(CALENDAR_VIEW).mock(return_value=httpx.Response(200, json={"value": [timed_event()]}))
    provider = build_provider(tmp_path)

    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    assert isinstance(snapshot, CalendarSnapshot)
    assert [c.id for c in snapshot.calendars] == ["outlook"]
    (event,) = snapshot.events
    assert event.calendar_id == "outlook"
    assert event.title == "Product stand-up"
    expected = datetime(2026, 9, 5, 9, 0, tzinfo=UTC).astimezone(_LOCAL_TZ).replace(tzinfo=None)
    assert event.starts_at == expected
    assert event.starts_at.tzinfo is None


@respx.mock
def test_reads_each_cached_account_as_a_household_calendar(tmp_path) -> None:
    respx.get(CALENDAR_VIEW).mock(
        side_effect=[
            httpx.Response(200, json={"value": [timed_event(id="mia-event")]}),
            httpx.Response(200, json={"value": [timed_event(id="sam-event")]}),
        ]
    )
    provider = PersonalOutlookCalendarProvider(make_settings(tmp_path))

    class FakeApp:
        def get_accounts(self):
            return [{"username": "mia@outlook.com"}, {"username": "sam@outlook.com"}]

    provider._app = FakeApp()  # type: ignore[assignment]
    provider._acquire_token_silent = lambda account=None: f"token-{account['username']}"  # type: ignore[method-assign,index]

    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    assert [calendar.id for calendar in snapshot.calendars] == [
        "mia@outlook.com",
        "sam@outlook.com",
    ]
    assert [event.calendar_id for event in snapshot.events] == [
        "mia@outlook.com",
        "sam@outlook.com",
    ]


@respx.mock
def test_resolves_category_colors_from_master_categories(tmp_path) -> None:
    respx.get(CALENDAR_VIEW).mock(
        return_value=httpx.Response(200, json={"value": [timed_event(categories=["Family"])]})
    )
    master = respx.get(MASTER_CATEGORIES).mock(
        return_value=httpx.Response(
            200,
            json={"value": [{"id": "Family", "displayName": "Family", "color": "preset5"}]},
        )
    )
    provider = build_provider(tmp_path)

    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )

    (event,) = snapshot.events
    assert event.categories[0].color == "#16a085"
    assert master.called


@respx.mock
def test_pagination_follows_next_link(tmp_path) -> None:
    respx.get(CALENDAR_VIEW).mock(
        side_effect=[
            httpx.Response(
                200,
                json={
                    "value": [timed_event(id="evt-a")],
                    "@odata.nextLink": CALENDAR_VIEW + "?%24skiptoken=abc",
                },
            ),
            httpx.Response(200, json={"value": [timed_event(id="evt-b")]}),
        ]
    )
    provider = build_provider(tmp_path)

    snapshot = provider.snapshot(
        CalendarRange(starts_on=date(2026, 9, 5), ends_on=date(2026, 9, 5))
    )
    assert {event.id for event in snapshot.events} == {"evt-a", "evt-b"}


def test_create_event_is_not_supported(tmp_path) -> None:
    provider = build_provider(tmp_path)
    with pytest.raises(NotImplementedError, match="read-only"):
        provider.create_event(
            CalendarEvent(
                id="x",
                calendar_id="outlook",
                title="Nope",
                starts_at=datetime(2026, 9, 5, 9, 0),
                ends_at=datetime(2026, 9, 5, 10, 0),
            )
        )
