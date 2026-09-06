"""Personal Microsoft account (outlook.com / hotmail.com) calendar provider.

App-only / client-credentials access does not work for personal Microsoft
accounts, so this provider uses delegated MSAL device-code sign-in: a household
member signs in once with ``python -m app.auth login``; the resulting refresh
token is cached to disk (``MISSION_CONTROL_GRAPH_TOKEN_CACHE``) and renewed
silently afterwards. Read-only.

Graph event JSON is mapped with the shared helpers in ``app.calendar.graph``.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any

import httpx
import msal

from app.calendar.graph import (
    _GRAPH_BASE,
    _LOCAL_TZ,
    _PAGE_SIZE,
    _SELECT_FIELDS,
    _local_tz_name,
    _map_event,
)
from app.config import Settings
from app.models import CalendarEvent, CalendarRange, CalendarSnapshot, HouseholdCalendar

GRAPH_SCOPES = ["Calendars.Read"]
SIGN_IN_HINT = "run `python -m app.auth login` from the backend directory"


def cache_path(settings: Settings) -> Path:
    return Path(settings.graph_token_cache).expanduser()


def load_msal_app(
    settings: Settings,
) -> tuple[msal.PublicClientApplication, msal.SerializableTokenCache, Path]:
    """Build the MSAL public client and its on-disk token cache."""
    if not settings.graph_client_id:
        raise RuntimeError("Personal Outlook provider requires MISSION_CONTROL_GRAPH_CLIENT_ID")

    path = cache_path(settings)
    cache = msal.SerializableTokenCache()
    if path.exists():
        cache.deserialize(path.read_text(encoding="utf-8"))

    app = msal.PublicClientApplication(
        settings.graph_client_id,
        authority=settings.graph_authority,
        token_cache=cache,
    )
    return app, cache, path


def save_cache(cache: msal.SerializableTokenCache, path: Path) -> None:
    if cache.has_state_changed:
        path.write_text(cache.serialize(), encoding="utf-8")


class PersonalOutlookCalendarProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.Client | None = None,
        token_provider: Callable[[], str] | None = None,
    ) -> None:
        self._settings = settings
        self._client = client or httpx.Client(timeout=30.0)
        self._app: msal.PublicClientApplication | None = None
        if token_provider is not None:
            self._token_provider = token_provider
        else:
            self._app, self._cache, self._cache_path = load_msal_app(settings)
            self._token_provider = self._acquire_token_silent

    # -- auth ---------------------------------------------------------------

    def _acquire_token_silent(self) -> str:
        assert self._app is not None
        accounts = self._app.get_accounts()
        if not accounts:
            raise RuntimeError(f"Personal Outlook calendar is not signed in — {SIGN_IN_HINT}")
        result = self._app.acquire_token_silent(GRAPH_SCOPES, account=accounts[0])
        save_cache(self._cache, self._cache_path)
        if not result or "access_token" not in result:
            raise RuntimeError(f"Personal Outlook sign-in expired or was revoked — {SIGN_IN_HINT}")
        return str(result["access_token"])

    def _account_email(self) -> str:
        accounts = self._app.get_accounts() if self._app is not None else []
        return accounts[0]["username"] if accounts else "outlook"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token_provider()}",
            "Prefer": f'outlook.timezone="{_local_tz_name()}"',
        }

    # -- fetch ------------------------------------------------------------------

    def _calendar_view(self, start: datetime, end: datetime) -> list[dict[str, Any]]:
        params: dict[str, str] = {
            "startDateTime": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endDateTime": end.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "$select": _SELECT_FIELDS,
            "$top": str(_PAGE_SIZE),
        }
        view_url = f"{_GRAPH_BASE}/me/calendarView"
        url: str | None = view_url
        raw_events: list[dict[str, Any]] = []
        while url:
            response = self._client.get(
                url,
                params=params if url == view_url else None,
                headers=self._headers(),
            )
            response.raise_for_status()
            body = response.json()
            raw_events.extend(body.get("value", []))
            url = body.get("@odata.nextLink")
        return raw_events

    def snapshot(self, calendar_range: CalendarRange) -> CalendarSnapshot:
        start = datetime.combine(calendar_range.starts_on, time.min).replace(tzinfo=_LOCAL_TZ)
        end = datetime.combine(calendar_range.ends_on + timedelta(days=1), time.min).replace(
            tzinfo=_LOCAL_TZ
        )

        email = self._account_email()
        events = [_map_event(raw, email) for raw in self._calendar_view(start, end)]
        events.sort(key=lambda event: (event.starts_at, event.ends_at, event.title))

        calendar = HouseholdCalendar(
            id=email,
            name=email.split("@", 1)[0],
            color=self._settings.calendar_color_for(0),
        )
        return CalendarSnapshot(calendars=[calendar], events=events, range=calendar_range)

    # -- write ----------------------------------------------------------------

    def create_event(self, event: CalendarEvent) -> CalendarEvent:
        raise NotImplementedError(
            "The personal Outlook provider is read-only. Grant the Calendars.ReadWrite "
            "scope and implement POST /me/events to enable writes."
        )


__all__ = [
    "GRAPH_SCOPES",
    "PersonalOutlookCalendarProvider",
    "load_msal_app",
    "save_cache",
]
