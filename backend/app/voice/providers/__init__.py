"""Conversational voice providers for the Mission Control bake-off.

One adapter per contestant (see ``docs/voice-provider-bakeoff-plan.md``). The
shared plumbing — system prompt, tool contract, grant caching/freshness, the
kiosk turn state machine — lives above these packages in ``app/voice/`` and does
not know which provider is in use.

``get_adapter`` resolves the *effective* provider: a process-memory override set
via ``PUT /api/voice/config`` (the bake-off's A/B affordance — a restart reverts
it), else ``settings.voice_provider``.
"""

from __future__ import annotations

from functools import lru_cache

from app.config import Settings
from app.models import VoiceProviderId
from app.voice.base import (
    PROVIDER_LABELS,
    VoiceProviderAdapter,
    VoiceUnavailable,
)

__all__ = [
    "PROVIDER_LABELS",
    "VoiceProviderAdapter",
    "VoiceProviderId",
    "VoiceUnavailable",
    "effective_provider",
    "get_adapter",
    "implemented_providers",
    "provider_configured",
    "reset_provider_override",
    "set_provider_override",
]

# Providers with a working adapter. The Azure paths are unverified against live
# Azure resources (see docs/voice-provider-bakeoff-plan.md) but are wired end to
# end. Selecting one that is not configured is a clear 409, never a silent
# fall-back to Gemini.
_IMPLEMENTED: tuple[VoiceProviderId, ...] = (
    "gemini",
    "azure_voice_live",
    "azure_openai_realtime",
    "azure_openai_realtime_mini",
    "local",
)

_override: VoiceProviderId | None = None


def implemented_providers() -> tuple[VoiceProviderId, ...]:
    return _IMPLEMENTED


def effective_provider(settings: Settings) -> VoiceProviderId:
    return _override or settings.voice_provider


def set_provider_override(provider: VoiceProviderId | None) -> None:
    """Point every subsequent turn at ``provider`` (or clear the override).

    Process-memory only — not persisted, not a per-viewer preference. The caller
    is responsible for clearing the token cache so a grant for the old provider
    is not re-served.
    """
    global _override
    if provider is not None and provider not in _IMPLEMENTED:
        raise VoiceUnavailable(
            f"voice provider {provider!r} is not implemented yet "
            f"(available: {', '.join(_IMPLEMENTED)})"
        )
    _override = provider


def reset_provider_override() -> None:
    global _override
    _override = None


@lru_cache
def _adapter_for(provider: VoiceProviderId) -> VoiceProviderAdapter:
    # Imported lazily and memoised so the `gemini` path never needs an Azure SDK,
    # and vice versa (the same pattern as the calendar providers).
    if provider == "gemini":
        from app.voice.providers.gemini import GeminiAdapter

        return GeminiAdapter()
    if provider in ("azure_openai_realtime", "azure_openai_realtime_mini"):
        from app.voice.providers.azure_openai_realtime import AzureOpenAIRealtimeAdapter

        return AzureOpenAIRealtimeAdapter(mini=provider == "azure_openai_realtime_mini")
    if provider == "azure_voice_live":
        from app.voice.providers.azure_voice_live import AzureVoiceLiveAdapter

        return AzureVoiceLiveAdapter()
    if provider == "local":
        from app.voice.local.adapter import LocalHybridAdapter

        return LocalHybridAdapter()
    raise VoiceUnavailable(
        f"voice provider {provider!r} is not implemented yet "
        "(set MISSION_CONTROL_VOICE_PROVIDER=gemini)"
    )


def get_adapter(settings: Settings) -> VoiceProviderAdapter:
    """The adapter for the currently-effective ``voice_provider``."""
    return _adapter_for(effective_provider(settings))


def provider_configured(settings: Settings, provider: VoiceProviderId) -> bool:
    """True when ``provider`` has everything it needs to serve a turn."""
    if provider not in _IMPLEMENTED:
        return False
    try:
        return _adapter_for(provider).missing_config(settings) is None
    except VoiceUnavailable:
        return False
