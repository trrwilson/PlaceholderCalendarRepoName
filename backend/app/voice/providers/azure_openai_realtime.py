"""Azure OpenAI Realtime adapters (``gpt-realtime-2.1`` and ``...-mini``).

Two bake-off contestants off one Azure OpenAI resource, distinguished by
deployment. Both connect through the backend relay (``app/voice/relay.py``) —
see that module for why browser-direct is not used.

Uses the **GA `/openai/v1/realtime` surface** (OpenAI-parity): no ``api-version``,
``model=<deployment>`` in the query, and the GA event model. The preview
``/openai/realtime`` + ``api-version`` + ``deployment=`` path is deliberately not
used — mixing GA and preview formats is a 404.

UNVERIFIED against a live Azure OpenAI resource: confirm the deployment names
exist and (optionally) set ``MISSION_CONTROL_AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT``
to a transcribe-model deployment for a live user transcript
(``docs/voice-provider-bakeoff-plan.md``).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.config import Settings
from app.models import VoiceProviderId, VoiceToken
from app.voice.base import VoiceUnavailable
from app.voice.prompt import build_system_instruction
from app.voice.relay import (
    UpstreamConfig,
    build_openai_ga_session,
    issue_ticket,
    openai_turn_detection,
    to_wss,
)
from app.voice.tools import as_openai_tools


class AzureOpenAIRealtimeAdapter:
    """``VoiceProviderAdapter`` for Azure OpenAI Realtime."""

    reusable_grant = False  # the relay ticket is single-use
    default_endpointing = "hybrid"

    def __init__(self, *, mini: bool) -> None:
        self._mini = mini
        self.id: VoiceProviderId = "azure_openai_realtime_mini" if mini else "azure_openai_realtime"

    def _deployment(self, settings: Settings) -> str:
        return (
            settings.azure_openai_realtime_mini_deployment
            if self._mini
            else settings.azure_openai_realtime_deployment
        )

    def missing_config(self, settings: Settings) -> str | None:
        if not settings.azure_openai_endpoint:
            return "MISSION_CONTROL_AZURE_OPENAI_ENDPOINT is not configured"
        if not settings.azure_openai_api_key:
            return "MISSION_CONTROL_AZURE_OPENAI_API_KEY is not configured"
        return None

    async def create_grant(
        self,
        settings: Settings,
        *,
        calendar_names: list[str],
        surface: str | None,
        now_local: datetime,
        timezone: str | None,
        schedule: str = "",
    ) -> VoiceToken:
        if reason := self.missing_config(settings):
            raise VoiceUnavailable(reason)

        deployment = self._deployment(settings)
        endpointing = settings.azure_openai_realtime_endpointing
        url = f"{to_wss(settings.azure_openai_endpoint)}/openai/v1/realtime?model={deployment}"
        session = build_openai_ga_session(
            instructions=build_system_instruction(now_local, calendar_names, timezone, schedule),
            tools=as_openai_tools(),
            voice=settings.azure_openai_realtime_voice,
            turn_detection=openai_turn_detection(endpointing),
            transcribe_deployment=settings.azure_openai_transcribe_deployment,
        )
        config = UpstreamConfig(
            provider=self.id,
            url=url,
            headers={"api-key": settings.azure_openai_api_key},
            session_update=session,
            endpointing=endpointing,
        )
        ttl = settings.voice_relay_ticket_ttl_seconds
        ticket = issue_ticket(config, ttl)
        return VoiceToken(
            provider=self.id,
            token=ticket,
            model=deployment,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl),
            endpointing=endpointing,
            surface=surface,
        )
