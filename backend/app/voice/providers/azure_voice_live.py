"""Azure Voice Live adapter.

Voice Live is a **separate Azure product** (not the Azure OpenAI GA surface): it
wraps a realtime model with speech-first features (input noise reduction,
server-side echo cancellation, Azure semantic VAD, HD voices). It still uses an
``api-version`` query param and the flat/beta ``session`` shape (``modalities``,
a ``voice`` object, flat ``turn_detection``), so it has its own session builder
(``build_voice_live_session``); the shared relay translation in
``app/voice/relay.py`` already accepts its event names.

UNVERIFIED against a live Voice Live resource — the endpoint host style
(``services.ai.azure.com`` vs ``cognitiveservices.azure.com``), ``api-version``,
the transcription model, and the exact noise-reduction / echo-cancellation keys
need an on-Azure spike (``docs/voice-provider-bakeoff-plan.md``).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.config import Settings
from app.models import VoiceProviderId, VoiceToken
from app.voice.base import VoiceUnavailable
from app.voice.prompt import build_system_instruction
from app.voice.relay import (
    UpstreamConfig,
    build_voice_live_session,
    issue_ticket,
    to_wss,
    voice_live_turn_detection,
)
from app.voice.tools import as_openai_tools


class AzureVoiceLiveAdapter:
    """``VoiceProviderAdapter`` for Azure Voice Live."""

    id: VoiceProviderId = "azure_voice_live"
    reusable_grant = False  # the relay ticket is single-use
    # `azure_semantic_vad` must stay on (its echo canceller needs it), so `client`
    # end-of-speech is not available for this product — `hybrid` or `provider`.
    default_endpointing = "hybrid"

    def missing_config(self, settings: Settings) -> str | None:
        if not settings.azure_voice_live_endpoint:
            return "MISSION_CONTROL_AZURE_VOICE_LIVE_ENDPOINT is not configured"
        if not settings.azure_voice_live_api_key:
            return "MISSION_CONTROL_AZURE_VOICE_LIVE_API_KEY is not configured"
        return None

    async def create_grant(
        self,
        settings: Settings,
        *,
        calendar_names: list[str],
        surface: str | None,
        now_local: datetime,
        timezone: str | None,
    ) -> VoiceToken:
        if reason := self.missing_config(settings):
            raise VoiceUnavailable(reason)

        model = settings.azure_voice_live_model
        endpointing = settings.azure_voice_live_endpointing
        url = (
            f"{to_wss(settings.azure_voice_live_endpoint)}/voice-live/realtime"
            f"?api-version={settings.azure_voice_live_api_version}&model={model}"
        )
        session = build_voice_live_session(
            instructions=build_system_instruction(now_local, calendar_names, timezone),
            tools=as_openai_tools(),
            voice=settings.azure_voice_live_voice,
            voice_type=settings.azure_voice_live_voice_type,
            transcription_model=settings.azure_voice_live_transcribe_model,
            turn_detection=voice_live_turn_detection(endpointing),
            extras={
                # Voice Live's speech-first additions; the whole reason to run it.
                "input_audio_noise_reduction": {"type": "azure_deep_noise_suppression"},
                "input_audio_echo_cancellation": {"type": "server_echo_cancellation"},
            },
        )
        config = UpstreamConfig(
            provider=self.id,
            url=url,
            headers={"api-key": settings.azure_voice_live_api_key},
            session_update=session,
            endpointing=endpointing,
        )
        ttl = settings.voice_relay_ticket_ttl_seconds
        ticket = issue_ticket(config, ttl)
        return VoiceToken(
            provider=self.id,
            token=ticket,
            model=model,
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl),
            endpointing=endpointing,
            surface=surface,
        )
