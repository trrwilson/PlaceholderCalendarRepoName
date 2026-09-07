"""Voice assistant support.

The kiosk browser runs the conversational turn itself (see
``docs/voice-support-plan.md``); the backend hands it a short-lived, constrained
session grant via ``POST /api/voice/token`` and answers the read-only calendar /
timer tools on ``/api/*``. Which provider mints that grant is a bake-off
(``docs/voice-provider-bakeoff-plan.md``); the shared prompt, tool contract and
grant caching sit above the provider adapters in ``app/voice/providers/``.
"""

from app.voice.base import VoiceProviderAdapter, VoiceUnavailable
from app.voice.cache import get_voice_token, reset_voice_token_cache
from app.voice.providers import get_adapter

__all__ = [
    "VoiceProviderAdapter",
    "VoiceUnavailable",
    "get_adapter",
    "get_voice_token",
    "reset_voice_token_cache",
]
