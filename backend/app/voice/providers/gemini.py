"""Gemini Live adapter: mint short-lived, constrained ephemeral tokens.

The kiosk browser holds the Gemini Live session itself; this only mints a token
whose model, system instruction, tools, voice, transcription and VAD config are
locked server-side (the browser can then only supply audio and tool responses).
The Gemini API key never leaves the backend.

History and the on-kiosk debugging record for this path are in
``docs/voice-support-plan.md``.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.config import Settings
from app.models import VoiceToken
from app.voice.base import VoiceProviderId, VoiceUnavailable
from app.voice.prompt import build_system_instruction
from app.voice.tools import as_gemini_tools


def _build_client(api_key: str, api_version: str):
    """Isolated so tests can substitute a fake client."""
    from google import genai

    # Ephemeral tokens only work for the Live API, and the minting client and the
    # browser's Live connection must agree on the API version. That version is
    # `v1beta` (ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens); the page
    # said `v1alpha` when this code was written, which is what pinned the kiosk to
    # the now-deprecated `...-native-audio-preview-12-2025` model. The version
    # travels back to the browser on the token response so the two cannot drift
    # apart again.
    return genai.Client(api_key=api_key, http_options={"api_version": api_version})


def _thinking_config(model: str) -> dict:
    if model.startswith("gemini-2."):
        return {"thinking_budget": 0, "include_thoughts": False}
    return {"thinking_level": "minimal", "include_thoughts": False}


def _realtime_input_config(settings: Settings) -> dict:
    """Who decides where the user's turn ends.

    Manual (``voice_manual_activity``) switches the service VAD off entirely and
    leaves the kiosk to bracket the turn with activityStart/activityEnd. That is
    deterministic, but it also stops the service transcribing incrementally: it
    buffers the utterance and only runs ASR once ``activityEnd`` arrives, which is
    where the multi-second post-utterance stall — and the complete absence of
    ``interimInputTranscription`` — came from.

    The default is hybrid: the service VAD stays on and keeps a streaming
    recogniser running under the audio, while the kiosk's own RMS silence
    detector sends ``audioStreamEnd`` the moment it hears the pause so the turn
    finalises without waiting out ``silence_duration_ms``.
    """
    if settings.voice_manual_activity:
        return {"automatic_activity_detection": {"disabled": True}}
    return {
        "automatic_activity_detection": {
            "disabled": False,
            "start_of_speech_sensitivity": "START_SENSITIVITY_HIGH",
            "end_of_speech_sensitivity": "END_SENSITIVITY_HIGH",
            "prefix_padding_ms": settings.voice_prefix_padding_ms,
            "silence_duration_ms": settings.voice_silence_duration_ms,
        },
        # Gemini 3.x defaults this to TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO.
        # There is no video here; be explicit so a turn is exactly the speech.
        "turn_coverage": "TURN_INCLUDES_ONLY_ACTIVITY",
    }


def _live_config(
    settings: Settings, calendar_names: list[str], now: datetime, tz_label: str | None
) -> dict:
    """The LiveConnectConfig locked into the token (browser cannot override these)."""
    from google.genai import types

    config: dict = {
        "response_modalities": [types.Modality.AUDIO],
        "system_instruction": build_system_instruction(now, calendar_names, tz_label),
        "tools": as_gemini_tools(),
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": settings.gemini_voice}},
        },
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        # This is a look-up assistant, not a reasoner: reasoning between tool
        # calls is pure latency. Gemini 3.x expresses that as `thinking_level`
        # ("minimal" is both the floor and the default); the 2.5 native-audio
        # models only understand `thinking_budget`, and sending the wrong one is
        # a setup error, so pick by model family.
        "thinking_config": _thinking_config(settings.gemini_live_model),
        "realtime_input_config": _realtime_input_config(settings),
    }
    if settings.gemini_language_code:
        config["speech_config"]["language_code"] = settings.gemini_language_code
    return config


def _endpointing(settings: Settings) -> str:
    """Gemini's effective end-of-speech mode. ``voice_manual_activity`` is the
    operator escape hatch: on -> ``client`` (service VAD off, kiosk brackets the
    turn); off -> ``hybrid`` (service VAD streams ASR, kiosk sends
    ``audioStreamEnd`` on its own silence detection)."""
    return "client" if settings.voice_manual_activity else "hybrid"


class GeminiAdapter:
    """``VoiceProviderAdapter`` for Gemini Live."""

    id: VoiceProviderId = "gemini"
    reusable_grant = True  # the ephemeral token is multi-use within its ttl
    default_endpointing = "hybrid"

    def missing_config(self, settings: Settings) -> str | None:
        if not settings.gemini_api_key:
            return "GEMINI_API_KEY_MISSION_CONTROL is not configured"
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
        if not settings.gemini_api_key:
            raise VoiceUnavailable("GEMINI_API_KEY_MISSION_CONTROL is not configured")

        from google.genai import types

        # Timezone-aware: the Gemini API rejects timestamps without a 'Z' / offset.
        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=settings.voice_token_ttl_seconds)

        client = _build_client(settings.gemini_api_key, settings.gemini_live_api_version)
        token = await client.aio.auth_tokens.create(
            config=types.CreateAuthTokenConfig(
                # 0 = unlimited within the window; see `voice_token_uses`. One token
                # backs many kiosk turns while the backend cache keeps serving it.
                uses=settings.voice_token_uses,
                expire_time=expires_at,
                # Match `expire_time`: a token the backend cached 25 minutes ago must
                # still be able to *open* a session. The staleness cap and event-
                # boundary invalidation in `app/voice/cache.py` are the real limit.
                new_session_expire_time=expires_at,
                live_connect_constraints=types.LiveConnectConstraints(
                    model=settings.gemini_live_model,
                    config=_live_config(settings, calendar_names, now_local, timezone),
                ),
            )
        )

        return VoiceToken(
            provider="gemini",
            token=token.name,
            expires_at=expires_at,
            model=settings.gemini_live_model,
            api_version=settings.gemini_live_api_version,
            endpointing=_endpointing(settings),
            surface=surface,
        )
