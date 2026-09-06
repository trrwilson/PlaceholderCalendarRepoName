"""Microsoft Graph (Outlook) calendar provider.

App-only (client credentials) access to one or more user mailboxes. Graph event
JSON is mapped to the provider-neutral domain models; all datetimes are converted
to naive local time at this boundary.
"""

from __future__ import annotations

import time as _time
from datetime import UTC, datetime, time, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from app.config import Settings
from app.models import (
    CalendarEvent,
    CalendarRange,
    CalendarSnapshot,
    EventCategory,
    HouseholdCalendar,
)

_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_SCOPE = "https://graph.microsoft.com/.default"
_TOKEN_LEEWAY_SECONDS = 60
_SELECT_FIELDS = "id,subject,start,end,isAllDay,location,categories"
_PAGE_SIZE = 100
_CATEGORY_COLORS = ("blue", "teal", "green", "red", "pink")

_LOCAL_TZ: tzinfo = datetime.now().astimezone().tzinfo or UTC


def _local_tz_name() -> str:
    """Best-effort IANA name for the host timezone for the Graph ``Prefer`` header.

    Falls back to ``UTC`` when the platform only exposes a fixed-offset zone
    (common on Windows); Graph then returns UTC and we convert locally.
    """
    return getattr(_LOCAL_TZ, "key", None) or "UTC"


def _resolve_tz(name: str | None) -> tzinfo:
    if not name or name.upper() == "UTC":
        return UTC
    try:
        return ZoneInfo(name)
    except Exception:
        # We asked Graph for _local_tz_name(); assume the response echoes it.
        return _LOCAL_TZ


def _parse_naive(value: str) -> datetime:
    """Parse a Graph dateTime string, discarding any timezone information."""
    return datetime.fromisoformat(value).replace(tzinfo=None)


def _to_local_naive(part: dict[str, Any]) -> datetime:
    parsed = datetime.fromisoformat(part["dateTime"])
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_resolve_tz(part.get("timeZone")))
    return parsed.astimezone(_LOCAL_TZ).replace(tzinfo=None)


def _slugify(value: str) -> str:
    slug = "".join(ch if ch.isalnum() else "-" for ch in value.lower())
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-") or "category"


def _category(name: str) -> EventCategory:
    color = _CATEGORY_COLORS[sum(map(ord, name)) % len(_CATEGORY_COLORS)]
    return EventCategory(id=_slugify(name), name=name, color=color)


def _map_event(raw: dict[str, Any], calendar_id: str) -> CalendarEvent:
    all_day = bool(raw.get("isAllDay"))
    if all_day:
        starts_at = _parse_naive(raw["start"]["dateTime"])
        ends_at = _parse_naive(raw["end"]["dateTime"])
    else:
        starts_at = _to_local_naive(raw["start"])
        ends_at = _to_local_naive(raw["end"])

    location = (raw.get("location") or {}).get("displayName") or None
    categories = [_category(name) for name in raw.get("categories", []) if name]

    return CalendarEvent(
        id=raw["id"],
        calendar_id=calendar_id,
        title=(raw.get("subject") or "").strip() or "(no title)",
        starts_at=starts_at,
        ends_at=ends_at,
        location=location,
        all_day=all_day,
        categories=categories,
    )


class MicrosoftGraphCalendarProvider:
    def __init__(self, settings: Settings, *, client: httpx.Client | None = None) -> None:
        missing = [
            name
            for name, value in (
                ("MISSION_CONTROL_GRAPH_TENANT_ID", settings.graph_tenant_id),
                ("MISSION_CONTROL_GRAPH_CLIENT_ID", settings.graph_client_id),
                ("MISSION_CONTROL_GRAPH_CLIENT_SECRET", settings.graph_client_secret),
            )
            if not value
        ]
        if missing:
            raise RuntimeError(
                "Microsoft Graph calendar provider is missing required settings: "
                + ", ".join(missing)
            )
        if not settings.graph_calendar_users:
            raise RuntimeError(
                "Microsoft Graph calendar provider requires MISSION_CONTROL_GRAPH_CALENDAR_USERS"
            )

        self._settings = settings
        self._client = client or httpx.Client(timeout=30.0)
        self._calendars = [
            HouseholdCalendar(
                id=user,
                name=user.split("@", 1)[0],
                color=settings.calendar_color_for(index),
            )
            for index, user in enumerate(settings.graph_calendar_users)
        ]
        self._token: str | None = None
        self._token_expires_at: float = 0.0

    # -- auth ---------------------------------------------------------------

    def _access_token(self) -> str:
        now = _time.monotonic()
        if self._token and now < self._token_expires_at - _TOKEN_LEEWAY_SECONDS:
            return self._token

        response = self._client.post(
            _TOKEN_URL.format(tenant=self._settings.graph_tenant_id),
            data={
                "client_id": self._settings.graph_client_id,
                "client_secret": self._settings.graph_client_secret,
                "scope": _SCOPE,
                "grant_type": "client_credentials",
            },
        )
        response.raise_for_status()
        payload = response.json()
        self._token = payload["access_token"]
        self._token_expires_at = now + float(payload.get("expires_in", 3600))
        return self._token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._access_token()}",
            "Prefer": f'outlook.timezone="{_local_tz_name()}"',
        }

    # -- fetch ------------------------------------------------------------------

    def _calendar_view(self, user: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        params: dict[str, str] = {
            "startDateTime": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endDateTime": end.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "$select": _SELECT_FIELDS,
            "$top": str(_PAGE_SIZE),
        }
        url: str | None = f"{_GRAPH_BASE}/users/{user}/calendarView"
        raw_events: list[dict[str, Any]] = []
        while url:
            response = self._client.get(
                url,
                params=params if url.endswith("/calendarView") else None,
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

        events: list[CalendarEvent] = []
        for user in self._settings.graph_calendar_users:
            for raw in self._calendar_view(user, start, end):
                events.append(_map_event(raw, user))

        events.sort(key=lambda event: (event.starts_at, event.ends_at, event.title))
        return CalendarSnapshot(calendars=self._calendars, events=events, range=calendar_range)

    # -- write ----------------------------------------------------------------

    def create_event(self, event: CalendarEvent) -> CalendarEvent:
        user = event.calendar_id
        tz_name = _local_tz_name()
        payload: dict[str, Any] = {
            "subject": event.title,
            "isAllDay": event.all_day,
            "start": {"dateTime": event.starts_at.isoformat(), "timeZone": tz_name},
            "end": {"dateTime": event.ends_at.isoformat(), "timeZone": tz_name},
            "categories": [category.name for category in event.categories],
        }
        if event.location:
            payload["location"] = {"displayName": event.location}

        response = self._client.post(
            f"{_GRAPH_BASE}/users/{user}/events",
            json=payload,
            headers={**self._headers(), "Content-Type": "application/json"},
        )
        response.raise_for_status()
        return _map_event(response.json(), user)
