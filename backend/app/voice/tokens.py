"""Mint short-lived, constrained Gemini Live API ephemeral tokens for the kiosk."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.config import Settings
from app.models import VoiceToken
from app.voice.prompt import build_system_instruction
from app.voice.tools import build_tools


class VoiceUnavailable(RuntimeError):
    """Voice support is turned off or not configured."""


def _build_client(api_key: str):
    """Isolated so tests can substitute a fake client."""
    from google import genai

    # Ephemeral tokens work ONLY on v1alpha — both here and on the browser client
    # (ai.google.dev/gemini-api/docs/ephemeral-tokens: "only works for the live
    # API, and only with the v1alpha version"; the JS SDK warns the same at
    # runtime). This also constrains the model: the v1alpha ephemeral-token path
    # takes the native-audio *preview* models, not `gemini-3.1-flash-live-preview`.
    return genai.Client(api_key=api_key, http_options={"api_version": "v1alpha"})


def _local_now(client_time: str | None) -> datetime:
    """The kiosk's wall clock. The backend itself may run in UTC, so trust the
    ISO string the browser sent (local time, no offset) over ``datetime.now()``."""
    if client_time:
        try:
            return datetime.fromisoformat(client_time).replace(tzinfo=None)
        except ValueError:
            pass
    return datetime.now()


def _live_config(
    settings: Settings, calendar_names: list[str], now: datetime, tz_label: str | None
) -> dict:
    """The LiveConnectConfig locked into the token (browser cannot override these)."""
    from google.genai import types

    config: dict = {
        "response_modalities": [types.Modality.AUDIO],
        "system_instruction": build_system_instruction(now, calendar_names, tz_label),
        "tools": build_tools(),
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": settings.gemini_voice}},
        },
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        # The 12-2025 native-audio model thinks before answering; with the default
        # budget a "what's tomorrow?" turn spent ~10 s reasoning between tool
        # calls. This is a look-up assistant, not a reasoner — turn it off.
        "thinking_config": {"thinking_budget": 0, "include_thoughts": False},
        # Manual activity detection. The service VAD, plus a client-sent
        # `audioStreamEnd`, repeatedly left turns that produced no transcript and
        # no reply. The kiosk now brackets each turn itself with
        # activityStart / activityEnd (its own RMS silence detector decides when),
        # which is the deterministic push-to-talk path.
        "realtime_input_config": {
            "automatic_activity_detection": {"disabled": True},
        },
    }
    if settings.gemini_language_code:
        config["speech_config"]["language_code"] = settings.gemini_language_code
    return config


async def mint_token(
    settings: Settings,
    *,
    calendar_names: list[str] | None = None,
    surface: str | None = None,
    timezone: str | None = None,
    client_time: str | None = None,
) -> VoiceToken:
    if not settings.voice_enabled:
        raise VoiceUnavailable("voice support is disabled (set MISSION_CONTROL_VOICE_ENABLED=true)")
    if not settings.gemini_api_key:
        raise VoiceUnavailable("GEMINI_API_KEY_MISSION_CONTROL is not configured")

    from google.genai import types

    # Timezone-aware: the Gemini API rejects timestamps without a 'Z' / offset.
    now = datetime.now(UTC)
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
                config=_live_config(
                    settings, calendar_names or [], _local_now(client_time), timezone
                ),
            ),
        )
    )

    return VoiceToken(
        token=token.name,
        expires_at=expires_at,
        model=settings.gemini_live_model,
        surface=surface,
    )
