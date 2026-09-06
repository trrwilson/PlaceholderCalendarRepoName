from datetime import date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CalendarColor(StrEnum):
    coral = "coral"
    ocean = "ocean"
    gold = "gold"
    fern = "fern"
    violet = "violet"


class HouseholdCalendar(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    color: CalendarColor
    enabled: bool = True


class EventCategory(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    # The category's display colour, resolved from the provider (e.g. an Outlook
    # master-category swatch) to a concrete ``#rrggbb`` the frontend renders
    # directly. Names stay authoritative; unknown colours degrade to a neutral hex.
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class CalendarEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    calendar_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    starts_at: datetime
    ends_at: datetime
    location: str | None = None
    all_day: bool = False
    categories: list[EventCategory] = Field(default_factory=list)

    @model_validator(mode="after")
    def end_follows_start(self) -> "CalendarEvent":
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        if self.all_day and (
            self.starts_at.time() != datetime.min.time()
            or self.ends_at.time() != datetime.min.time()
        ):
            raise ValueError("all-day events must use midnight boundaries")
        return self


class CalendarRange(BaseModel):
    starts_on: date
    ends_on: date

    @model_validator(mode="after")
    def end_follows_start(self) -> "CalendarRange":
        if self.ends_on < self.starts_on:
            raise ValueError("ends_on must not precede starts_on")
        return self


class CalendarSnapshot(BaseModel):
    calendars: list[HouseholdCalendar]
    events: list[CalendarEvent]
    range: CalendarRange


class ApplicationMessage(BaseModel):
    type: str
    message: str
    snapshot: CalendarSnapshot | None = None


class VoiceTokenRequest(BaseModel):
    """Optional hints from the kiosk when it asks for a voice token.

    ``surface`` identifies the requesting screen. It is unused today (one kiosk),
    but is accepted now so a future multi-screen setup can route a spoken command
    to a specific display without an API change.

    The backend may run in UTC, so the assistant's "today" is stamped from the
    kiosk's own clock: ``client_time`` is the local wall-clock time as an ISO
    string without offset (e.g. ``2026-09-05T23:30:00``) and ``timezone`` is the
    IANA name (e.g. ``America/Los_Angeles``) used only as a label.
    """

    surface: str | None = None
    timezone: str | None = None
    client_time: str | None = None


class VoiceToken(BaseModel):
    """A short-lived Gemini Live API ephemeral token for the kiosk browser.

    The browser opens the Live session directly with this; the Gemini API key
    stays on the backend. ``expires_at`` is when a session must have *started* by.
    """

    token: str
    expires_at: datetime
    model: str
    surface: str | None = None


class CalendarAuthStatus(BaseModel):
    """State of the calendar provider's sign-in, for the kiosk connect UI."""

    provider: str
    state: Literal["connected", "connecting", "disconnected", "not_applicable"]
    account: str | None = None
    # All household accounts currently available to the personal provider.  ``account``
    # remains the first entry for clients that predate multi-account support.
    accounts: list[str] = Field(default_factory=list)
    # Present while state == "connecting": show these so a phone can finish sign-in.
    user_code: str | None = None
    verification_uri: str | None = None
    verification_uri_complete: str | None = None
    verification_qr: str | None = None  # data: URI for an SVG QR code
    expires_in: int | None = None
    error: str | None = None
