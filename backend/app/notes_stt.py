"""Dictation provider seam for the Home notes pane's push-to-talk text field.

Its own switch from the conversational ``voice_provider`` bake-off — see
``app/config.py``'s ``notes_stt_provider`` comment for why. Mirrors the shape
of ``app/voice/providers/__init__.py`` (labels, effective-provider override,
``configured`` check) without the full ``VoiceProviderAdapter`` protocol,
since there is no session grant to mint here — just a one-shot
transcription call.
"""

from __future__ import annotations

from app.config import Settings
from app.models import NotesSttProviderId
from app.voice.base import VoiceUnavailable

__all__ = [
    "NOTES_STT_PROVIDER_LABELS",
    "effective_notes_stt_provider",
    "notes_stt_provider_configured",
    "set_notes_stt_provider_override",
    "transcribe",
]

NOTES_STT_PROVIDER_LABELS: dict[NotesSttProviderId, str] = {
    "gemini": "Gemini (transcription)",
    "local": "Local / on-device",
    "disabled": "Off (typing only)",
}

_IMPLEMENTED: tuple[NotesSttProviderId, ...] = ("gemini", "local", "disabled")

_override: NotesSttProviderId | None = None


def implemented_notes_stt_providers() -> tuple[NotesSttProviderId, ...]:
    return _IMPLEMENTED


def effective_notes_stt_provider(settings: Settings) -> NotesSttProviderId:
    return _override or settings.notes_stt_provider


def set_notes_stt_provider_override(provider: NotesSttProviderId | None) -> None:
    """Point the next dictation call at ``provider`` (or clear the override).

    Process-memory only, same bake-off shape as
    ``app.voice.providers.set_provider_override`` — not persisted.
    """
    global _override
    if provider is not None and provider not in _IMPLEMENTED:
        raise VoiceUnavailable(f"notes dictation provider {provider!r} is not implemented")
    _override = provider


def notes_stt_provider_configured(settings: Settings, provider: NotesSttProviderId) -> bool:
    """True when ``provider`` has everything it needs to serve a dictation call."""
    if provider == "disabled":
        return True
    if provider == "gemini":
        return bool(settings.gemini_api_key)
    if provider == "local":
        # On-device engine; a missing model fails at first use, same as the voice local path.
        return True
    return False


async def transcribe(settings: Settings, pcm16: bytes) -> str:
    """Dispatch one-shot dictation audio to the effective provider.

    Raises :class:`VoiceUnavailable` when dictation is off or the effective
    provider is not configured — surfaced by the caller as a 409, never a
    silent fall-back to another provider.
    """
    provider = effective_notes_stt_provider(settings)
    if provider == "disabled":
        raise VoiceUnavailable("notes dictation is disabled")
    if provider == "gemini":
        from app.voice.providers.gemini import transcribe_pcm16

        return await transcribe_pcm16(settings, pcm16)
    if provider == "local":
        from app.voice.local.engines import create_recognizer
        from app.voice.local.session import get_recognizer

        recognizer = await get_recognizer(lambda: create_recognizer(settings))
        recognizer.reset()
        events = recognizer.accept_audio(pcm16) + recognizer.finalize()
        text = next((event.text for event in reversed(events) if event.type == "final"), "")
        return text.strip()
    raise VoiceUnavailable(f"notes dictation provider {provider!r} is not implemented")
