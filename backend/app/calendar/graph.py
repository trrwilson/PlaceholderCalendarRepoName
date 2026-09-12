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

from app.calendar.secondary import SecondaryCalendarStore, get_secondary_calendar_store
from app.config import Settings
from app.models import (
    CalendarEvent,
    CalendarRange,
    CalendarSnapshot,
    CalendarSource,
    EventCategory,
    HouseholdCalendar,
)

_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
_GRAPH_BASE = "https://graph.microsoft.com/v1.0"
_SCOPE = "https://graph.microsoft.com/.default"
_TOKEN_LEEWAY_SECONDS = 60
_SELECT_FIELDS = "id,subject,start,end,isAllDay,location,categories"
_PAGE_SIZE = 100

# Outlook stores a category's display colour on the mailbox's *master category*
# list (``GET .../outlook/masterCategories``) as one of 25 named swatches
# (``color: "presetN"``); an event only carries category *names*. We resolve the
# names against that list and hand the frontend a concrete hex value. The hex
# below approximates the Outlook-on-the-web palette — hue fidelity matters more
# than an exact per-client match (see AGENTS.md "Semantic color").
_PRESET_HEX: dict[str, str] = {
    "preset0": "#e74c3c",  # Red
    "preset1": "#e8890c",  # Orange
    "preset2": "#a1662f",  # Brown
    "preset3": "#f2c94c",  # Yellow
    "preset4": "#27ae60",  # Green
    "preset5": "#16a085",  # Teal
    "preset6": "#808000",  # Olive
    "preset7": "#2d9cdb",  # Blue
    "preset8": "#9b59b6",  # Purple
    "preset9": "#c2185b",  # Cranberry
    "preset10": "#95a5a6",  # Steel
    "preset11": "#5d6d7e",  # DarkSteel
    "preset12": "#bdc3c7",  # Gray
    "preset13": "#7f8c8d",  # DarkGray
    "preset14": "#2c3e50",  # Black
    "preset15": "#c0392b",  # DarkRed
    "preset16": "#d35400",  # DarkOrange
    "preset17": "#6e4b3a",  # DarkBrown
    "preset18": "#c9a227",  # DarkYellow
    "preset19": "#1e8449",  # DarkGreen
    "preset20": "#0e6655",  # DarkTeal
    "preset21": "#556b2f",  # DarkOlive
    "preset22": "#1f618d",  # DarkBlue
    "preset23": "#6c3483",  # DarkPurple
    "preset24": "#8e1b4e",  # DarkCranberry
}
# Category not on the master list (e.g. deleted) or mapped to ``none``: a neutral
# marker, matching the frontend's default category dot.
_NEUTRAL_CATEGORY_HEX = "#6e8596"
# ``masterCategories`` changes rarely; a kiosk polls the snapshot every ~30s, so
# cache the per-mailbox colour map rather than refetching it each time.
_MASTER_CATEGORIES_TTL_SECONDS = 600.0

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


def _category(name: str, colors: dict[str, str]) -> EventCategory:
    color = colors.get(name.casefold(), _NEUTRAL_CATEGORY_HEX)
    return EventCategory(id=_slugify(name), name=name, color=color)


def _parse_master_categories(payload: dict[str, Any]) -> dict[str, str]:
    """Map a ``masterCategories`` response to ``{casefolded name: hex colour}``."""
    colors: dict[str, str] = {}
    for entry in payload.get("value", []):
        name = (entry.get("displayName") or "").strip()
        if not name:
            continue
        preset = (entry.get("color") or "").casefold()
        colors[name.casefold()] = _PRESET_HEX.get(preset, _NEUTRAL_CATEGORY_HEX)
    return colors


class CategoryColorCache:
    """Per-mailbox cache of Outlook category display colours.

    A failed refresh reuses the previous value (or an empty map), so a transient
    Graph error just degrades categories to neutral markers instead of failing
    the whole snapshot.
    """

    def __init__(self, client: httpx.Client, ttl: float = _MASTER_CATEGORIES_TTL_SECONDS) -> None:
        self._client = client
        self._ttl = ttl
        self._entries: dict[str, tuple[float, dict[str, str]]] = {}

    def get(self, mailbox_url: str, headers: dict[str, str], scope: str) -> dict[str, str]:
        now = _time.monotonic()
        cached = self._entries.get(scope)
        if cached is not None and now < cached[0]:
            return cached[1]
        colors = cached[1] if cached is not None else {}
        try:
            response = self._client.get(f"{mailbox_url}/outlook/masterCategories", headers=headers)
            response.raise_for_status()
            colors = _parse_master_categories(response.json())
        except httpx.HTTPError:
            pass
        self._entries[scope] = (now + self._ttl, colors)
        return colors


# The account holder's profile is read from ``/me`` (personal) or
# ``/users/{id}`` (tenant) purely to give each household calendar a natural
# name. ``givenName`` is preferred so the kiosk / voice say "Travis" rather than
# "Travis Wilson" or "trrwilson"; ``displayName`` is the next best thing.
_PROFILE_SELECT = "givenName,displayName"
# Names change about never; refetch at most hourly (and cache misses too, so a
# token without directory access does not retry every snapshot).
_PROFILE_TTL_SECONDS = 3600.0


def _natural_name(payload: dict[str, Any]) -> str | None:
    for key in ("givenName", "displayName"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    return None


class ProfileNameCache:
    """Per-account cache of the holder's natural name from Microsoft Graph.

    A forbidden or failed request (the delegated token may not carry
    ``User.Read``; an app-only token may lack ``User.Read.All``) just yields
    ``None`` and the caller falls back to the raw account name — a friendly
    name is a nicety, never worth failing a snapshot over.
    """

    def __init__(self, client: httpx.Client, ttl: float = _PROFILE_TTL_SECONDS) -> None:
        self._client = client
        self._ttl = ttl
        self._entries: dict[str, tuple[float, str | None]] = {}

    def get(self, profile_url: str, headers: dict[str, str], scope: str) -> str | None:
        now = _time.monotonic()
        cached = self._entries.get(scope)
        if cached is not None and now < cached[0]:
            return cached[1]
        name = cached[1] if cached is not None else None
        try:
            response = self._client.get(
                profile_url, params={"$select": _PROFILE_SELECT}, headers=headers
            )
            response.raise_for_status()
            name = _natural_name(response.json())
        except Exception:
            # Any failure at all (HTTP error, missing scope, malformed body) just
            # means we keep the raw account name. Never break a snapshot for this.
            pass
        self._entries[scope] = (now + self._ttl, name)
        return name


_CALENDAR_LIST_SELECT = "id,name,isDefaultCalendar"


def list_calendars(client: httpx.Client, base_url: str, headers: dict[str, str]) -> list[dict[str, Any]]:
    """List a mailbox's calendars (``{base_url}/calendars``, paged) — the ones
    beyond the default calendar a household member can opt into displaying
    (see ``app/calendar/secondary.py``)."""
    params: dict[str, str] = {"$select": _CALENDAR_LIST_SELECT, "$top": str(_PAGE_SIZE)}
    url: str | None = f"{base_url}/calendars"
    calendars: list[dict[str, Any]] = []
    while url:
        response = client.get(url, params=params if url.endswith("/calendars") else None, headers=headers)
        response.raise_for_status()
        body = response.json()
        calendars.extend(body.get("value", []))
        url = body.get("@odata.nextLink")
    return calendars


def secondary_calendar_id(account_id: str, graph_calendar_id: str) -> str:
    """Stable id for a non-primary calendar: ``{account}::{graph calendar id}``.

    The ``::`` also marks a calendar as non-primary — a primary calendar's id
    is always just the bare account email/UPN — so a provider's
    ``set_calendar_enabled`` can reject an attempt to toggle a primary one.
    """
    return f"{account_id}::{graph_calendar_id}"


def _map_event(
    raw: dict[str, Any],
    calendar_id: str,
    category_colors: dict[str, str] | None = None,
) -> CalendarEvent:
    all_day = bool(raw.get("isAllDay"))
    if all_day:
        starts_at = _parse_naive(raw["start"]["dateTime"])
        ends_at = _parse_naive(raw["end"]["dateTime"])
    else:
        starts_at = _to_local_naive(raw["start"])
        ends_at = _to_local_naive(raw["end"])

    location = (raw.get("location") or {}).get("displayName") or None
    colors = category_colors or {}
    categories = [_category(name, colors) for name in raw.get("categories", []) if name]

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
    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.Client | None = None,
        secondary_store: SecondaryCalendarStore | None = None,
    ) -> None:
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
        self._token: str | None = None
        self._token_expires_at: float = 0.0
        self._category_colors = CategoryColorCache(self._client)
        self._profile_names = ProfileNameCache(self._client)
        self._secondary_store = secondary_store or get_secondary_calendar_store()

    def _household_calendar(self, user: str, index: int) -> HouseholdCalendar:
        account_name = user.split("@", 1)[0]
        natural = self._profile_names.get(f"{_GRAPH_BASE}/users/{user}", self._headers(), user)
        return HouseholdCalendar(
            id=user,
            name=account_name,
            display_name=natural or account_name,
            color=self._settings.calendar_color_for(index),
            source=CalendarSource.outlook,
        )

    def set_calendar_enabled(self, calendar_id: str, enabled: bool) -> None:
        if "::" not in calendar_id:
            raise ValueError("only a non-primary calendar can be toggled")
        self._secondary_store.set_enabled(calendar_id, enabled)

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

    def _calendar_view(
        self, user: str, start: datetime, end: datetime, *, calendar_id: str | None = None
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {
            "startDateTime": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endDateTime": end.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "$select": _SELECT_FIELDS,
            "$top": str(_PAGE_SIZE),
        }
        base = (
            f"{_GRAPH_BASE}/users/{user}/calendars/{calendar_id}/calendarView"
            if calendar_id
            else f"{_GRAPH_BASE}/users/{user}/calendarView"
        )
        url: str | None = base
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
        calendars: list[HouseholdCalendar] = []
        for index, user in enumerate(self._settings.graph_calendar_users):
            raw_events = self._calendar_view(user, start, end)
            colors = self._category_colors_for(user, raw_events)
            events.extend(_map_event(raw, user, colors) for raw in raw_events)
            calendars.append(self._household_calendar(user, index))

            try:
                raw_calendars = list_calendars(self._client, f"{_GRAPH_BASE}/users/{user}", self._headers())
            except httpx.HTTPError:
                raw_calendars = []
            for raw_calendar in raw_calendars:
                if raw_calendar.get("isDefaultCalendar") or not raw_calendar.get("id"):
                    continue
                graph_id = raw_calendar["id"]
                extra_id = secondary_calendar_id(user, graph_id)
                extra_name = (raw_calendar.get("name") or "").strip() or "Calendar"
                is_enabled = self._secondary_store.is_enabled(extra_id)
                calendars.append(
                    HouseholdCalendar(
                        id=extra_id,
                        name=extra_name,
                        display_name=extra_name,
                        color=self._settings.calendar_color_for(index),
                        source=CalendarSource.outlook,
                        enabled=is_enabled,
                        is_primary=False,
                        account_id=user,
                    )
                )
                if not is_enabled:
                    continue
                extra_raw_events = self._calendar_view(user, start, end, calendar_id=graph_id)
                extra_colors = self._category_colors_for(user, extra_raw_events)
                events.extend(_map_event(raw, extra_id, extra_colors) for raw in extra_raw_events)

        events.sort(key=lambda event: (event.starts_at, event.ends_at, event.title))
        return CalendarSnapshot(calendars=calendars, events=events, range=calendar_range)

    def _category_colors_for(self, user: str, raw_events: list[dict[str, Any]]) -> dict[str, str]:
        if not any(raw.get("categories") for raw in raw_events):
            return {}
        return self._category_colors.get(f"{_GRAPH_BASE}/users/{user}", self._headers(), user)

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
        created = response.json()
        colors = (
            self._category_colors.get(f"{_GRAPH_BASE}/users/{user}", self._headers(), user)
            if created.get("categories")
            else {}
        )
        return _map_event(created, user, colors)
