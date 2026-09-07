"""Provider-neutral voice plumbing shared by every conversational voice provider.

The kiosk experience is the same regardless of which provider handles a turn:
tap or wake -> speak -> the agent answers out loud and moves the display, and may
set one kitchen timer. What differs per provider is only *how the session
credential is obtained* and *how the locked session config is expressed*. That
difference is a `VoiceProviderAdapter`; everything above it — the system prompt,
the tool contract, the freshness/caching rules, the turn state machine — is
shared and lives outside the provider packages.

See ``docs/voice-provider-bakeoff-plan.md`` and ``AGENTS.md`` ->
"Voice assistant -> Provider architecture".
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable

from app.config import Settings
from app.models import VoiceProviderId, VoiceToken

__all__ = [
    "PROVIDER_LABELS",
    "VoiceProviderAdapter",
    "VoiceProviderId",
    "VoiceToken",
    "VoiceUnavailable",
    "local_now",
]

# Friendly names for the Settings picker and diagnostics. Keyed by every known
# provider id (implemented or not) so the UI can label a contestant that is not
# wired up yet.
PROVIDER_LABELS: dict[VoiceProviderId, str] = {
    "gemini": "Gemini Live",
    "azure_voice_live": "Azure Voice Live",
    "azure_openai_realtime": "Azure OpenAI Realtime (gpt-realtime-2.1)",
    "azure_openai_realtime_mini": "Azure OpenAI Realtime (mini)",
}


class VoiceUnavailable(RuntimeError):
    """Voice support is turned off, or the selected provider is not configured."""


def local_now(client_time: str | None) -> datetime:
    """The kiosk's wall clock as a naive local ``datetime``.

    The backend itself may run in UTC, so trust the ISO string the browser sent
    (local time, no offset) over ``datetime.now()``. Shared with
    :mod:`app.voice.cache`, which compares it against event boundary times (also
    naive local) to decide when a cached grant has gone stale — this freshness
    logic is provider-independent because every provider stamps "it is now …"
    into its system prompt.
    """
    if client_time:
        try:
            return datetime.fromisoformat(client_time).replace(tzinfo=None)
        except ValueError:
            pass
    return datetime.now()


@runtime_checkable
class VoiceProviderAdapter(Protocol):
    """Turns Mission Control's shared conversational config into a session grant
    for one specific provider.

    Implementations live in ``app/voice/providers/``. They must not reach a
    calendar provider directly — the household calendar names are handed in, and
    tool *execution* stays in the browser / on ``/api/*`` endpoints.
    """

    id: VoiceProviderId

    #: True when a minted grant can be handed to more than one turn (Gemini's
    #: token is multi-use). False for the relay providers — their grant carries a
    #: single-use ticket, so ``app.voice.cache`` must mint a fresh one per turn.
    reusable_grant: bool

    def missing_config(self, settings: Settings) -> str | None:
        """A human-readable reason this provider cannot serve a turn, or ``None``
        when it is ready. Surfaced to the kiosk as the 409 body."""
        ...

    async def create_grant(
        self,
        settings: Settings,
        *,
        calendar_names: list[str],
        surface: str | None,
        now_local: datetime,
        timezone: str | None,
    ) -> VoiceToken:
        """Mint / obtain a short-lived, constrained session grant for the kiosk.

        ``now_local`` is the kiosk's wall clock (naive local); ``timezone`` is its
        IANA label, used only for the "it is now …" stamp in the system prompt.
        """
        ...
