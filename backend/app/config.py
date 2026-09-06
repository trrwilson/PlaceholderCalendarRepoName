from functools import lru_cache
from typing import Annotated, Literal

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from app.models import CalendarColor


def _split_csv(value: object) -> object:
    """Allow comma-separated strings for list-valued settings."""
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


class Settings(BaseSettings):
    """Runtime configuration, read from the environment and an optional .env file.

    All variables use the ``MISSION_CONTROL_`` prefix, e.g.
    ``MISSION_CONTROL_CALENDAR_PROVIDER=graph``.
    """

    model_config = SettingsConfigDict(
        env_prefix="MISSION_CONTROL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    calendar_provider: Literal["mock", "graph", "outlook_personal"] = "mock"

    graph_tenant_id: str | None = None
    graph_client_id: str | None = None
    graph_client_secret: str | None = None

    # Personal-account (outlook.com / hotmail.com) delegated sign-in.
    graph_authority: str = "https://login.microsoftonline.com/consumers"
    graph_token_cache: str = ".msal_token_cache.json"
    # The calendar sign-in endpoints reveal the account and can sign out; by
    # default they only answer requests from the local network / loopback.
    allow_remote_auth: bool = False

    # Mailboxes to surface; each UPN / email becomes one HouseholdCalendar.
    graph_calendar_users: Annotated[list[str], NoDecode] = []
    # Optional parallel list of CalendarColor names, one per configured user.
    graph_calendar_colors: Annotated[list[str], NoDecode] = []

    @field_validator("graph_calendar_users", "graph_calendar_colors", mode="before")
    @classmethod
    def _parse_list(cls, value: object) -> object:
        return _split_csv(value)

    # -- Voice assistant (Gemini Live, native-audio) --------------------------
    # The kiosk browser talks to the Gemini Live API directly using a
    # short-lived ephemeral token minted by POST /api/voice/token; this key
    # never leaves the backend. It is provisioned as GEMINI_API_KEY_MISSION_CONTROL
    # (outside the MISSION_CONTROL_ prefix), but MISSION_CONTROL_GEMINI_API_KEY
    # also works.
    gemini_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "GEMINI_API_KEY_MISSION_CONTROL",
            "MISSION_CONTROL_GEMINI_API_KEY",
            "gemini_api_key",
        ),
    )
    voice_enabled: bool = False
    # Current native-audio Live model that the v1alpha ephemeral-token path
    # accepts (it is the model in Google's own ephemeral-token JS example).
    # `gemini-3.1-flash-live-preview` is newer but needs v1beta, which the
    # ephemeral-token flow does not support. The older `...-09-2025` connected
    # but went silent + 1011'd after a tool call.
    gemini_live_model: str = "gemini-2.5-flash-native-audio-preview-12-2025"
    # Any prebuilt Gemini voice name (e.g. Zephyr, Puck, Charon, Kore, Aoede).
    gemini_voice: str = "Zephyr"
    # Optional BCP-47 code. Left blank for native-audio (it auto-detects and the
    # system prompt pins the response language); set for half-cascade models.
    gemini_language_code: str = ""
    # Ephemeral-token lifetime. A session must START within this window.
    voice_token_ttl_seconds: int = 600

    def calendar_color_for(self, index: int) -> CalendarColor:
        """Assign a stable CalendarColor to the configured user at ``index``.

        Uses ``graph_calendar_colors`` when provided, otherwise round-robins
        through the ``CalendarColor`` enum.
        """
        if self.graph_calendar_colors:
            name = self.graph_calendar_colors[index % len(self.graph_calendar_colors)]
            return CalendarColor(name)
        palette = list(CalendarColor)
        return palette[index % len(palette)]


@lru_cache
def get_settings() -> Settings:
    return Settings()
