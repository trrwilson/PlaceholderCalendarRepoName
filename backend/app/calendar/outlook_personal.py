"""Personal Microsoft account (outlook.com / hotmail.com) calendar provider.

App-only / client-credentials access does not work for personal Microsoft
accounts, so this provider uses delegated MSAL sign-in. A household member signs
in once — from the kiosk (``app.calendar.personal_auth`` device-flow endpoints)
or the CLI (``python -m app.auth login``) — and the refresh token is cached to
disk (``MISSION_CONTROL_GRAPH_TOKEN_CACHE``) and renewed silently afterwards.
Read-only.

Graph event JSON is mapped with the shared helpers in ``app.calendar.graph``.
"""

from __future__ import annotations

import base64
import binascii
import json
import threading
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
    CategoryColorCache,
    ProfileNameCache,
    _local_tz_name,
    _map_event,
    list_calendars,
    secondary_calendar_id,
)
from app.calendar.secondary import SecondaryCalendarStore, get_secondary_calendar_store
from app.config import Settings
from app.models import (
    CalendarEvent,
    CalendarRange,
    CalendarSnapshot,
    CalendarSource,
    HouseholdCalendar,
)

GRAPH_SCOPES = ["Calendars.Read"]
SIGN_IN_HINT = "sign in from the kiosk or run `python -m app.auth login`"

# "Microsoft Graph Command Line Tools" — Microsoft's own first-party public
# device-code client (the one `Connect-MgGraph` uses). It supports personal
# Microsoft accounts and has Calendars.Read pre-authorized, so the kiosk can sign
# a household member in with NO Azure app registration. The consent screen will
# say "Microsoft Graph Command Line Tools"; set MISSION_CONTROL_GRAPH_CLIENT_ID to
# your own registration for a branded prompt or tighter control.
DEFAULT_DEVICE_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e"

# Last observed silent-auth failure, surfaced by the /api/calendar/auth status
# endpoint so the kiosk can prompt for re-sign-in. Cleared on a fresh sign-in.
auth_error: str | None = None


def cache_path(settings: Settings) -> Path:
    return Path(settings.graph_token_cache).expanduser()


def load_msal_app(
    settings: Settings,
) -> tuple[msal.PublicClientApplication, msal.SerializableTokenCache, Path]:
    """Build a fresh MSAL public client and deserialize its on-disk token cache."""
    client_id = settings.graph_client_id or DEFAULT_DEVICE_CLIENT_ID

    path = cache_path(settings)
    cache = msal.SerializableTokenCache()
    if path.exists():
        cache.deserialize(path.read_text(encoding="utf-8"))

    app = msal.PublicClientApplication(
        client_id,
        authority=settings.graph_authority,
        token_cache=cache,
    )
    return app, cache, path


_shared_lock = threading.Lock()
# client_id -> [app, cache, path, cache_mtime]
_shared: dict[str, list[Any]] = {}
_written: dict[str, str] = {}


def shared_msal_app(
    settings: Settings,
) -> tuple[msal.PublicClientApplication, msal.SerializableTokenCache, Path]:
    """A process-wide MSAL client per client id, kept in sync with the cache file.

    The provider, the device-flow endpoints, and the CLI all share one client so
    a sign-in performed through any of them is visible to the others.
    """
    key = settings.graph_client_id or DEFAULT_DEVICE_CLIENT_ID
    with _shared_lock:
        entry = _shared.get(key)
        if entry is None:
            app, cache, path = load_msal_app(settings)
            mtime = path.stat().st_mtime if path.exists() else None
            _shared[key] = [app, cache, path, mtime]
            return app, cache, path

        app, cache, path, mtime = entry
        current = path.stat().st_mtime if path.exists() else None
        if current != mtime:
            cache.deserialize(path.read_text(encoding="utf-8") if path.exists() else "{}")
            entry[3] = current
        return app, cache, path


def save_cache(cache: msal.SerializableTokenCache, path: Path) -> None:
    """Persist the token cache atomically, only when its contents changed."""
    data = cache.serialize()
    if _written.get(str(path)) == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)
    _written[str(path)] = data
    _touch_shared_mtime(path)


def _touch_shared_mtime(path: Path) -> None:
    """Record that we just wrote ``path`` so shared_msal_app() does not reload it."""
    if not path.exists():
        return
    mtime = path.stat().st_mtime
    with _shared_lock:
        for entry in _shared.values():
            if entry[2] == path:
                entry[3] = mtime


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """Best-effort decode of a JWT payload. Signature is not verified — these
    claims came from our own MSAL cache and are only used for a display name."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (IndexError, ValueError, binascii.Error):
        return {}
    return claims if isinstance(claims, dict) else {}


def _cached_id_token_claims(
    cache: msal.SerializableTokenCache | None, account: dict[str, Any]
) -> dict[str, Any]:
    """The ID-token claims MSAL cached for ``account`` at sign-in.

    ``acquire_token_silent`` only echoes ``id_token_claims`` back when it actually
    hits the network to refresh; on the common warm-cache path (the on-disk cache
    survives restarts) it returns just the access token, so the holder's name
    would otherwise be unavailable until the token happened to expire. The ID
    token itself is always in the cache from the device-code sign-in, so read it
    straight from there.
    """
    home_account_id = account.get("home_account_id")
    if cache is None or not home_account_id:
        return {}
    try:
        entries = cache.search(
            msal.TokenCache.CredentialType.ID_TOKEN,
            query={"home_account_id": home_account_id},
        )
    except Exception:
        return {}
    for entry in entries:
        claims = _decode_jwt_claims(entry.get("secret", ""))
        if claims:
            return claims
    return {}


class PersonalOutlookCalendarProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.Client | None = None,
        token_provider: Callable[[], str] | None = None,
        secondary_store: SecondaryCalendarStore | None = None,
    ) -> None:
        self._settings = settings
        self._client = client or httpx.Client(timeout=30.0)
        self._category_colors = CategoryColorCache(self._client)
        self._profile_names = ProfileNameCache(self._client)
        self._secondary_store = secondary_store or get_secondary_calendar_store()
        # ID-token claims from the last silent auth, per account username. The
        # sign-in already carries the holder's name (``given_name`` / ``name``)
        # even though the calendar scope alone can't read ``/me``.
        self._id_claims: dict[str, dict[str, Any]] = {}
        self._app: msal.PublicClientApplication | None = None
        if token_provider is not None:
            self._token_provider = token_provider
        else:
            self._app, self._cache, self._cache_path = shared_msal_app(settings)
            self._token_provider = self._acquire_token_silent

    # -- auth ---------------------------------------------------------------

    def _acquire_token_silent(self, account: dict[str, Any] | None = None) -> str:
        global auth_error
        self._app, self._cache, self._cache_path = shared_msal_app(self._settings)
        accounts = self._app.get_accounts()
        if not accounts:
            auth_error = "not signed in"
            raise RuntimeError(f"Personal Outlook calendar is not signed in — {SIGN_IN_HINT}")
        result = self._app.acquire_token_silent(GRAPH_SCOPES, account=account or accounts[0])
        save_cache(self._cache, self._cache_path)
        _touch_shared_mtime(self._cache_path)
        if not result or "access_token" not in result:
            auth_error = "sign-in expired or was revoked"
            raise RuntimeError(f"Personal Outlook sign-in expired or was revoked — {SIGN_IN_HINT}")
        auth_error = None
        acct = account or accounts[0]
        username = acct.get("username")
        # `acquire_token_silent` only returns `id_token_claims` when it refreshed
        # over the network; on a warm-cache hit it does not. Fall back to the ID
        # token MSAL already has cached so the holder's name survives a restart.
        claims = result.get("id_token_claims")
        if not (isinstance(claims, dict) and claims):
            claims = _cached_id_token_claims(getattr(self, "_cache", None), acct)
        if isinstance(claims, dict) and claims and username:
            self._id_claims[str(username)] = claims
        return str(result["access_token"])

    def _natural_name_for(self, email: str, headers: dict[str, str]) -> str | None:
        """Best natural name for an account, in preference order:

        1. first (given) name — from the sign-in's ID-token claims, or ``/me``;
        2. full name — from ``/me`` (``displayName``) or the ID-token ``name``;
        3. ``None``, so the caller falls back to the raw account handle.

        The ID-token claims come free with the sign-in (no extra Graph scope);
        ``/me`` needs ``User.Read``, which the calendar token often lacks. Personal
        Microsoft accounts usually carry only ``name`` (no ``given_name``), so the
        common result here is the full name.
        """
        claims = self._id_claims.get(email, {})
        given = str(claims.get("given_name") or "").strip()
        if given:
            return given
        from_me = self._profile_names.get(f"{_GRAPH_BASE}/me", headers, email)
        if from_me:
            return from_me
        full = str(claims.get("name") or "").strip()
        return full or None

    def _account_email(self) -> str:
        accounts = self._app.get_accounts() if self._app is not None else []
        return accounts[0]["username"] if accounts else "outlook"

    def _headers(self, token: str | None = None) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token if token is not None else self._token_provider()}",
            "Prefer": f'outlook.timezone="{_local_tz_name()}"',
        }

    # -- fetch ------------------------------------------------------------------

    def _calendar_view(
        self,
        start: datetime,
        end: datetime,
        headers: dict[str, str],
        *,
        calendar_id: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {
            "startDateTime": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endDateTime": end.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "$select": _SELECT_FIELDS,
            "$top": str(_PAGE_SIZE),
        }
        view_url = (
            f"{_GRAPH_BASE}/me/calendars/{calendar_id}/calendarView"
            if calendar_id
            else f"{_GRAPH_BASE}/me/calendarView"
        )
        url: str | None = view_url
        raw_events: list[dict[str, Any]] = []
        while url:
            response = self._client.get(
                url,
                params=params if url == view_url else None,
                headers=headers,
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

        if self._app is None:
            accounts = [(self._account_email(), self._token_provider())]
        else:
            accounts = [
                (str(account["username"]), self._acquire_token_silent(account))
                for account in self._app.get_accounts()
                if account.get("username")
            ]
            if not accounts:
                self._acquire_token_silent()

        events: list[CalendarEvent] = []
        calendars: list[HouseholdCalendar] = []
        for index, (email, token) in enumerate(accounts):
            headers = self._headers(token)
            raw_events = self._calendar_view(start, end, headers)
            colors: dict[str, str] = {}
            if any(raw.get("categories") for raw in raw_events):
                colors = self._category_colors.get(f"{_GRAPH_BASE}/me", headers, email)
            events.extend(_map_event(raw, email, colors) for raw in raw_events)
            account_name = email.split("@", 1)[0]
            natural = self._natural_name_for(email, headers)
            calendars.append(
                HouseholdCalendar(
                    id=email,
                    name=account_name,
                    display_name=natural or account_name,
                    color=self._settings.calendar_color_for(index),
                    source=CalendarSource.outlook,
                )
            )

            try:
                raw_calendars = list_calendars(self._client, f"{_GRAPH_BASE}/me", headers)
            except httpx.HTTPError:
                raw_calendars = []
            for raw_calendar in raw_calendars:
                if raw_calendar.get("isDefaultCalendar") or not raw_calendar.get("id"):
                    continue
                graph_id = raw_calendar["id"]
                extra_id = secondary_calendar_id(email, graph_id)
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
                        account_id=email,
                    )
                )
                if not is_enabled:
                    continue
                extra_raw_events = self._calendar_view(start, end, headers, calendar_id=graph_id)
                extra_colors: dict[str, str] = {}
                if any(raw.get("categories") for raw in extra_raw_events):
                    extra_colors = self._category_colors.get(f"{_GRAPH_BASE}/me", headers, email)
                events.extend(_map_event(raw, extra_id, extra_colors) for raw in extra_raw_events)

        events.sort(key=lambda event: (event.starts_at, event.ends_at, event.title))
        return CalendarSnapshot(calendars=calendars, events=events, range=calendar_range)

    def set_calendar_enabled(self, calendar_id: str, enabled: bool) -> None:
        if "::" not in calendar_id:
            raise ValueError("only a non-primary calendar can be toggled")
        self._secondary_store.set_enabled(calendar_id, enabled)

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
    "shared_msal_app",
]
