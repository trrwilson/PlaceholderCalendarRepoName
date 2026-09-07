import pytest

from app.api import _build_provider
from app.config import Settings, get_settings
from app.timers import reset_timer_store
from app.voice import reset_voice_token_cache
from app.voice.providers import reset_provider_override
from app.voice.relay import reset_relay_tickets


@pytest.fixture(autouse=True)
def isolate_settings(monkeypatch: pytest.MonkeyPatch):
    """Keep tests hermetic: never read a developer's local ``backend/.env``.

    ``Settings`` loads ``.env`` relative to the working directory, which is
    ``backend/`` when pytest runs — so a real local config (a linked calendar, a
    Gemini key, voice enabled) would otherwise leak in. Individual tests still set
    what they need via ``monkeypatch.setenv`` / ``Settings(_env_file=None, ...)``.
    """
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    get_settings.cache_clear()
    _build_provider.cache_clear()
    reset_timer_store()
    reset_voice_token_cache()
    reset_provider_override()
    reset_relay_tickets()
    yield
    get_settings.cache_clear()
    _build_provider.cache_clear()
    reset_timer_store()
    reset_voice_token_cache()
    reset_provider_override()
    reset_relay_tickets()
