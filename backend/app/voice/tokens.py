"""Mint short-lived, constrained Gemini Live API ephemeral tokens for the kiosk."""

from __future__ import annotations

from datetime import datetime, timedelta

from app.config import Settings
from app.models import VoiceToken
from app.voice.prompt import build_system_instruction
from app.voice.tools import build_tools


class VoiceUnavailable(RuntimeError):
    """Voice support is turned off or not configured."""


def _build_client(api_key: str):
    """Isolated so tests can substitute a fake client."""
    from google import genai

    return genai.Client(api_key=api_key, http_options={"api_version": "v1alpha"})


def _live_config(settings: Settings, calendar_names: list[str]) -> dict:
    """The LiveConnectConfig locked into the token (browser cannot override these)."""
    from google.genai import types

    config: dict = {
        "response_modalities": [types.Modality.AUDIO],
        "system_instruction": build_system_instruction(datetime.now(), calendar_names),
        "tools": build_tools(),
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": settings.gemini_voice}},
        },
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        # Kiosk uses tap-to-talk: it sends explicit activity start/end, no server VAD.
        "realtime_input_config": {"automatic_activity_detection": {"disabled": True}},
    }
    if settings.gemini_language_code:
        config["speech_config"]["language_code"] = settings.gemini_language_code
    return config


async def mint_token(
    settings: Settings,
    *,
    calendar_names: list[str] | None = None,
    surface: str | None = None,
) -> VoiceToken:
    if not settings.voice_enabled:
        raise VoiceUnavailable("voice support is disabled (set MISSION_CONTROL_VOICE_ENABLED=true)")
    if not settings.gemini_api_key:
        raise VoiceUnavailable("GEMINI_API_KEY_MISSION_CONTROL is not configured")

    from google.genai import types

    now = datetime.now()
    expires_at = now + timedelta(seconds=settings.voice_token_ttl_seconds)

    client = _build_client(settings.gemini_api_key)
    token = await client.aio.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            uses=1,
            expire_time=expires_at,
            # A session must be opened within a minute of handing the token out.
            new_session_expire_time=now + timedelta(seconds=60),
            live_connect_constraints=types.LiveConnectConstraints(
                model=settings.gemini_live_model,
                config=_live_config(settings, calendar_names or []),
            ),
        )
    )

    return VoiceToken(
        token=token.name,
        expires_at=expires_at,
        model=settings.gemini_live_model,
        surface=surface,
    )
