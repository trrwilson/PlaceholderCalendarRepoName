import types
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

import app.voice.tokens as tokens
from app.api import _build_provider
from app.config import get_settings
from app.main import app


@pytest.fixture(autouse=True)
def _fresh_caches():
    get_settings.cache_clear()
    _build_provider.cache_clear()
    yield
    get_settings.cache_clear()
    _build_provider.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def voice_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("GEMINI_API_KEY_MISSION_CONTROL", "test-key")
    get_settings.cache_clear()


def _fake_client_factory(recorder: dict):
    create = AsyncMock(return_value=types.SimpleNamespace(name="auth_tokens/opaque"))
    recorder["create"] = create
    auth_tokens = types.SimpleNamespace(create=create)
    fake = types.SimpleNamespace(aio=types.SimpleNamespace(auth_tokens=auth_tokens))
    return lambda api_key: fake


def test_token_requires_voice_enabled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    response = client.post("/api/voice/token")
    assert response.status_code == 409
    assert "disabled" in response.json()["detail"]


def test_token_requires_api_key(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.delenv("GEMINI_API_KEY_MISSION_CONTROL", raising=False)
    monkeypatch.delenv("MISSION_CONTROL_GEMINI_API_KEY", raising=False)
    get_settings.cache_clear()
    response = client.post("/api/voice/token")
    assert response.status_code == 409
    assert "GEMINI_API_KEY_MISSION_CONTROL" in response.json()["detail"]


def test_token_gated_to_local_network(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY_MISSION_CONTROL", "test-key")
    get_settings.cache_clear()
    # TestClient's default client host ("testclient") is not a private address.
    response = client.post("/api/voice/token")
    assert response.status_code == 403


def test_token_minted_with_locked_constraints(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    recorder: dict = {}
    monkeypatch.setattr(tokens, "_build_client", _fake_client_factory(recorder))

    response = client.post("/api/voice/token", json={"surface": "kitchen"})

    assert response.status_code == 200
    body = response.json()
    assert body["token"] == "auth_tokens/opaque"
    assert body["model"] == "gemini-2.5-flash-native-audio-preview-09-2025"
    assert body["surface"] == "kitchen"

    config = recorder["create"].await_args.kwargs["config"]
    assert config.uses == 1
    constraint = config.live_connect_constraints
    assert constraint.model == body["model"]
    # The tools and the household calendar names are locked into the token.
    functions = constraint.config.tools[0].function_declarations
    assert {f.name for f in functions} == {
        "show_view",
        "focus_date",
        "highlight_event",
        "get_events",
        "get_agenda",
        "check_conflicts",
    }
    assert "Family" in str(constraint.config.system_instruction)
    assert constraint.config.realtime_input_config.automatic_activity_detection.disabled is True
