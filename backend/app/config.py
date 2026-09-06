from functools import lru_cache
from typing import Annotated, Literal

from pydantic import field_validator
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
    )

    calendar_provider: Literal["mock", "graph"] = "mock"

    graph_tenant_id: str | None = None
    graph_client_id: str | None = None
    graph_client_secret: str | None = None

    # Mailboxes to surface; each UPN / email becomes one HouseholdCalendar.
    graph_calendar_users: Annotated[list[str], NoDecode] = []
    # Optional parallel list of CalendarColor names, one per configured user.
    graph_calendar_colors: Annotated[list[str], NoDecode] = []

    @field_validator("graph_calendar_users", "graph_calendar_colors", mode="before")
    @classmethod
    def _parse_list(cls, value: object) -> object:
        return _split_csv(value)

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
