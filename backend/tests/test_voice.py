import itertools
import types
from datetime import date, timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.voice.providers.gemini as gemini_provider
from app.api import _build_provider
from app.config import Settings, get_settings
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
    counter = itertools.count(1)
    create = AsyncMock(
        side_effect=lambda **_: types.SimpleNamespace(name=f"auth_tokens/opaque-{next(counter)}")
    )
    recorder["create"] = create
    auth_tokens = types.SimpleNamespace(create=create)
    fake = types.SimpleNamespace(aio=types.SimpleNamespace(auth_tokens=auth_tokens))
    return lambda api_key, api_version="v1beta": fake


def _iso_at(hhmmss: str, *, day_offset: int = 0) -> str:
    """A kiosk ``client_time`` at ``hhmmss`` on today (+/- an offset), naive local.

    The mock calendar seeds its events relative to ``date.today()``, so tests that
    need a ``client_time`` near a known event boundary anchor to the same day.
    """
    return f"{(date.today() + timedelta(days=day_offset)).isoformat()}T{hhmmss}"


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


def test_token_rejects_an_unconfigured_provider(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Selecting a provider with no credentials is a clear 409, not a silent
    fall-back to Gemini."""
    monkeypatch.setenv("MISSION_CONTROL_VOICE_PROVIDER", "azure_openai_realtime")
    get_settings.cache_clear()
    response = client.post("/api/voice/token")
    assert response.status_code == 409
    assert "AZURE_OPENAI_ENDPOINT" in response.json()["detail"]


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
    monkeypatch.setattr(gemini_provider, "_build_client", _fake_client_factory(recorder))

    response = client.post("/api/voice/token", json={"surface": "kitchen"})

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "gemini"
    assert body["token"] == "auth_tokens/opaque-1"
    assert body["model"] == "gemini-3.1-flash-live-preview"
    # The kiosk opens its Live socket on the version the token was minted with.
    assert body["api_version"] == "v1beta"
    # Default end-of-speech: the service VAD streams ASR and emits speech events,
    # the kiosk endpoints on them with a mic-RMS backstop.
    assert body["endpointing"] == "hybrid"
    assert "manual_activity" not in body
    assert body["surface"] == "kitchen"

    config = recorder["create"].await_args.kwargs["config"]
    # 0 = unlimited uses within the ttl window: one token backs many kiosk turns
    # while the backend cache keeps serving it.
    assert config.uses == 0
    constraint = config.live_connect_constraints
    assert constraint.model == body["model"]
    # The tools and the household calendar names are locked into the token.
    functions = constraint.config.tools[0].function_declarations
    assert {f.name for f in functions} == {
        "show_view",
        "focus_date",
        "highlight_event",
        "set_people_filter",
        "get_events",
        "get_agenda",
        "check_conflicts",
        "start_timer",
        "cancel_timer",
        "extend_timer",
        "pause_timer",
        "resume_timer",
        "restart_timer",
        "get_timer",
        "add_to_list",
        "remove_from_list",
        "check_off_item",
        "clear_list",
        "get_list",
        "enter_privacy_mode",
        "request_privacy_unlock",
    }
    # The six-hour cap is carried in the timer tool descriptions so the agent can
    # speak the rejection rather than silently failing.
    start_timer = next(f for f in functions if f.name == "start_timer")
    assert "six hours" in start_timer.description
    assert "Family" in str(constraint.config.system_instruction)
    activity_detection = constraint.config.realtime_input_config.automatic_activity_detection
    # Hybrid VAD: the service keeps its streaming recogniser running under the
    # audio (so a transcript exists before the turn ends) and endpoints eagerly;
    # the kiosk still finalises the turn itself with `audioStreamEnd`.
    assert activity_detection.disabled is False
    assert activity_detection.silence_duration_ms == 250
    # Gemini 3.x expresses "do not reason between tool calls" as thinking_level.
    assert constraint.config.thinking_config.thinking_level == "MINIMAL"


def test_manual_activity_disables_the_service_vad(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The old deterministic push-to-talk path is still reachable by config —
    `voice_manual_activity` selects `endpointing = "client"`."""
    monkeypatch.setenv("MISSION_CONTROL_VOICE_MANUAL_ACTIVITY", "true")
    get_settings.cache_clear()
    recorder: dict = {}
    monkeypatch.setattr(gemini_provider, "_build_client", _fake_client_factory(recorder))

    response = client.post("/api/voice/token")

    assert response.status_code == 200
    assert response.json()["endpointing"] == "client"
    constraint = recorder["create"].await_args.kwargs["config"].live_connect_constraints
    assert constraint.config.realtime_input_config.automatic_activity_detection.disabled is True


def test_native_audio_model_keeps_the_thinking_budget_form(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`thinking_level` is a Gemini 3.x field; 2.5 native audio wants a budget."""
    monkeypatch.setenv(
        "MISSION_CONTROL_GEMINI_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"
    )
    monkeypatch.setenv("MISSION_CONTROL_GEMINI_LIVE_API_VERSION", "v1alpha")
    get_settings.cache_clear()
    recorder: dict = {}
    monkeypatch.setattr(gemini_provider, "_build_client", _fake_client_factory(recorder))

    response = client.post("/api/voice/token")

    assert response.status_code == 200
    assert response.json()["api_version"] == "v1alpha"
    constraint = recorder["create"].await_args.kwargs["config"].live_connect_constraints
    assert constraint.config.thinking_config.thinking_budget == 0
    assert constraint.config.thinking_config.thinking_level is None


def test_token_stamps_the_kiosk_clock_not_the_server_clock(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    recorder: dict = {}
    monkeypatch.setattr(gemini_provider, "_build_client", _fake_client_factory(recorder))

    # The kiosk says it is late Saturday; the stamp must reflect that even though
    # the test host's own clock is something else entirely.
    response = client.post(
        "/api/voice/token",
        json={
            "surface": "kitchen",
            "timezone": "America/Los_Angeles",
            "client_time": "2026-09-05T23:30:00",
        },
    )
    assert response.status_code == 200

    instruction = str(
        recorder["create"]
        .await_args.kwargs["config"]
        .live_connect_constraints.config.system_instruction
    )
    assert "Saturday, September 5, 2026 at 11:30 PM" in instruction
    assert "America/Los_Angeles" in instruction
    assert "never shift it to UTC" in instruction


def test_token_bakes_the_schedule_digest_into_the_instruction(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A loose reference ("that dentist appointment") must be resolvable without a
    tool call, so ~a month of events — title, time, and location — is in the
    prompt. The mock calendar seeds the dentist at Cedar Street Dental tomorrow."""
    recorder: dict = {}
    monkeypatch.setattr(gemini_provider, "_build_client", _fake_client_factory(recorder))

    response = client.post("/api/voice/token", json={"client_time": _iso_at("08:00:00")})
    assert response.status_code == 200

    instruction = str(
        recorder["create"]
        .await_args.kwargs["config"]
        .live_connect_constraints.config.system_instruction
    )
    assert "Household schedule" in instruction
    assert "Dentist appointment" in instruction
    assert "Cedar Street Dental" in instruction
    # And the guidance to use it: match the words against title AND location.
    assert "against BOTH the title and the location" in instruction


def test_token_instruction_bars_follow_up_offers(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    recorder: dict = {}
    monkeypatch.setattr(gemini_provider, "_build_client", _fake_client_factory(recorder))
    client.post("/api/voice/token")
    instruction = str(
        recorder["create"]
        .await_args.kwargs["config"]
        .live_connect_constraints.config.system_instruction
    )
    assert "one self-contained exchange" in instruction
    assert "Do NOT tack on a follow-up" in instruction


# -- token / snapshot caching ------------------------------------------------
# The mock calendar's earliest events today: school drop-off 07:45–08:15,
# stand-up 09:00–09:30, swim practice 16:00–17:15, taco night 18:30–20:00.


@pytest.fixture
def faked_google(monkeypatch: pytest.MonkeyPatch) -> dict:
    recorder: dict = {}
    monkeypatch.setattr(gemini_provider, "_build_client", _fake_client_factory(recorder))
    return recorder


def _post_token(
    client: TestClient,
    hhmmss: str,
    *,
    tz: str = "America/Los_Angeles",
    day_offset: int = 0,
):
    return client.post(
        "/api/voice/token",
        json={"timezone": tz, "client_time": _iso_at(hhmmss, day_offset=day_offset)},
    )


def test_cached_token_is_reused_within_the_freshness_window(
    client: TestClient, voice_env, faked_google: dict
) -> None:
    first = _post_token(client, "14:00:00")
    second = _post_token(client, "14:05:00")  # still before swim practice at 16:00

    assert first.status_code == second.status_code == 200
    assert first.json()["token"] == second.json()["token"] == "auth_tokens/opaque-1"
    # Only one mint, and only one calendar-provider snapshot.
    assert faked_google["create"].await_count == 1


def test_cached_token_is_reminted_after_the_next_event_boundary(
    client: TestClient, voice_env, faked_google: dict
) -> None:
    before = _post_token(client, "15:59:00")  # swim practice starts 16:00
    after = _post_token(client, "16:01:00")

    assert before.json()["token"] == "auth_tokens/opaque-1"
    assert after.json()["token"] == "auth_tokens/opaque-2"
    assert faked_google["create"].await_count == 2


def test_cached_token_is_reminted_across_local_midnight(
    client: TestClient, voice_env, faked_google: dict
) -> None:
    late = _post_token(client, "23:58:00")
    early = _post_token(client, "00:03:00", day_offset=1)

    assert late.json()["token"] == "auth_tokens/opaque-1"
    assert early.json()["token"] == "auth_tokens/opaque-2"


def test_cached_token_is_not_shared_across_timezones(
    client: TestClient, voice_env, faked_google: dict
) -> None:
    _post_token(client, "14:00:00", tz="America/Los_Angeles")
    other = _post_token(client, "14:00:00", tz="America/New_York")

    assert other.json()["token"] == "auth_tokens/opaque-2"
    assert faked_google["create"].await_count == 2


def test_cache_hit_echoes_the_requesting_surface(
    client: TestClient, voice_env, faked_google: dict
) -> None:
    first = client.post(
        "/api/voice/token",
        json={"surface": "kitchen", "timezone": "UTC", "client_time": _iso_at("14:00:00")},
    )
    second = client.post(
        "/api/voice/token",
        json={"surface": "living-room", "timezone": "UTC", "client_time": _iso_at("14:01:00")},
    )

    assert faked_google["create"].await_count == 1
    assert first.json()["surface"] == "kitchen"
    assert second.json()["surface"] == "living-room"


def test_prompt_snapshot_is_shared_across_mints_within_its_ttl(
    client: TestClient, voice_env, faked_google: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = _build_provider()
    calls: list = []
    original = provider.snapshot
    monkeypatch.setattr(provider, "snapshot", lambda rng: calls.append(rng) or original(rng))

    # Two distinct mints (different zones) close in time: still one snapshot.
    _post_token(client, "14:00:00", tz="America/Los_Angeles")
    _post_token(client, "14:00:00", tz="America/New_York")

    assert faked_google["create"].await_count == 2
    assert len(calls) == 1


# -- provider config / bake-off switch --------------------------------------


def test_voice_config_lists_providers_and_the_effective_one(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("GEMINI_API_KEY_MISSION_CONTROL", "test-key")
    get_settings.cache_clear()

    body = client.get("/api/voice/config").json()
    assert body["enabled"] is True
    assert body["provider"] == "gemini"
    by_id = {p["id"]: p for p in body["providers"]}
    # Every known contestant is listed for the picker...
    assert set(by_id) == {
        "gemini",
        "azure_voice_live",
        "azure_openai_realtime",
        "azure_openai_realtime_mini",
        "local",
    }
    assert by_id["gemini"] == {
        "id": "gemini",
        "label": "Gemini Live",
        "implemented": True,
        "configured": True,
    }
    # The local pipeline is always "configured" — it degrades to the text-bypass
    # path when no STT engine is installed.
    assert by_id["local"]["implemented"] is True
    assert by_id["local"]["configured"] is True
    # The Azure contestants are wired up but have no credentials in the test env.
    assert by_id["azure_openai_realtime"]["implemented"] is True
    assert by_id["azure_openai_realtime"]["configured"] is False
    assert by_id["azure_voice_live"]["configured"] is False
    # The shared capture-pipeline gain rides along on this endpoint. Asserted
    # against the setting's own default, not a literal: the default is tuned on
    # real hardware and must not need a test edit every time it moves.
    assert body["mic_input_gain_db"] == Settings(_env_file=None).mic_input_gain_db


def test_voice_config_reports_the_mic_input_gain(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    default_db = Settings(_env_file=None).mic_input_gain_db
    assert client.get("/api/voice/config").json()["mic_input_gain_db"] == default_db

    # The stage is off by default; an install can opt into a boost.
    monkeypatch.setenv("MISSION_CONTROL_MIC_INPUT_GAIN_DB", "18")
    get_settings.cache_clear()
    assert client.get("/api/voice/config").json()["mic_input_gain_db"] == 18.0

    # A negative trim is allowed too.
    monkeypatch.setenv("MISSION_CONTROL_MIC_INPUT_GAIN_DB", "-3.5")
    get_settings.cache_clear()
    assert client.get("/api/voice/config").json()["mic_input_gain_db"] == -3.5


def test_mic_input_gain_rejects_out_of_range_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        Settings(_env_file=None, mic_input_gain_db=99.0)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, mic_input_gain_db=float("nan"))


def test_voice_config_switches_the_effective_provider(
    client: TestClient, voice_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Switching to an implemented-but-unconfigured contestant is allowed — the
    # config check happens when a turn actually asks for a grant.
    switched = client.put("/api/voice/config", json={"provider": "azure_voice_live"})
    assert switched.status_code == 200
    assert switched.json()["provider"] == "azure_voice_live"
    assert client.get("/api/voice/config").json()["provider"] == "azure_voice_live"

    # ...and now a token request fails clearly rather than falling back to Gemini.
    assert client.post("/api/voice/token").status_code == 409

    back = client.put("/api/voice/config", json={"provider": "gemini"})
    assert back.status_code == 200
    assert back.json()["provider"] == "gemini"


def test_voice_config_gated_to_local_network(client: TestClient) -> None:
    assert client.get("/api/voice/config").status_code == 403
    assert client.put("/api/voice/config", json={"provider": "gemini"}).status_code == 403


def test_wake_config_defaults_to_disabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    response = client.get("/api/voice/wake-config")
    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is False
    assert body["phrase"] == "Mission Control"
    # Same reasoning as the mic gain: the threshold is tuned against real
    # detections, so track the setting rather than pinning a number here.
    assert body["threshold"] == Settings(_env_file=None).wake_word_threshold
    assert body["model_path"].endswith("mission_control.onnx")
    # The wake-word bake-off: openWakeWord is the default back end, and both
    # contestants are advertised for the Settings picker.
    assert body["provider"] == "openwakeword"
    ids = {p["id"] for p in body["providers"]}
    assert ids == {"openwakeword", "azure"}
    oww = next(p for p in body["providers"] if p["id"] == "openwakeword")
    assert oww["implemented"] is True and oww["configured"] is True
    # The additive Invoke gate: not a provider; unavailable + off until a host
    # is set.
    assert body["invoke_gate_configured"] is False
    assert body["invoke_gate_enabled"] is False


def test_wake_config_put_switches_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    switched = client.put("/api/voice/wake-config", json={"provider": "azure"})
    assert switched.status_code == 200
    assert switched.json()["provider"] == "azure"
    # Process-memory override — a fresh GET sees it too.
    assert client.get("/api/voice/wake-config").json()["provider"] == "azure"
    assert client.put("/api/voice/wake-config", json={"provider": "nonsense"}).status_code == 422


def test_wake_config_put_gated_to_local_network(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", raising=False)
    get_settings.cache_clear()
    assert client.put("/api/voice/wake-config", json={"provider": "azure"}).status_code == 403


def test_wake_config_invoke_gate_configured_with_host(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST", "192.168.50.67")
    get_settings.cache_clear()
    body = client.get("/api/voice/wake-config").json()
    # Still two providers — the gate is not one of them.
    assert {p["id"] for p in body["providers"]} == {"openwakeword", "azure"}
    assert body["invoke_gate_configured"] is True
    assert body["invoke_gate_host"] == "192.168.50.67"
    assert body["invoke_gate_control_port"] == 5005


def test_wake_config_put_toggles_invoke_gate(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    assert client.get("/api/voice/wake-config").json()["invoke_gate_enabled"] is False
    switched = client.put("/api/voice/wake-config", json={"invoke_gate_enabled": True})
    assert switched.status_code == 200
    assert switched.json()["invoke_gate_enabled"] is True
    # Process-memory override — a fresh GET sees it, the provider is unchanged.
    reread = client.get("/api/voice/wake-config").json()
    assert reread["invoke_gate_enabled"] is True
    assert reread["provider"] == "openwakeword"


def test_wake_azure_ws_refused_when_not_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Voice + wake on, but the .table is missing (and the native SDK is absent
    # in CI) — the socket is refused rather than accepted and left hanging.
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_AZURE_MODEL_PATH", "/no/such/keyword.table")
    get_settings.cache_clear()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/voice/wake/azure"):
            pass


def test_wake_config_enabled_only_with_voice_and_wake_flags(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_THRESHOLD", "0.7")
    get_settings.cache_clear()
    # Wake word on but voice off — still not enabled: no turn to open.
    assert client.get("/api/voice/wake-config").json()["enabled"] is False

    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    get_settings.cache_clear()
    body = client.get("/api/voice/wake-config").json()
    assert body["enabled"] is True
    assert body["threshold"] == 0.7


def test_wake_config_gated_to_local_network(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", raising=False)
    get_settings.cache_clear()
    response = client.get("/api/voice/wake-config")
    assert response.status_code == 403


# -- voice debug audio capture ---------------------------------------------------


def _wav_bytes(sample_rate: int = 16_000, samples: int = 1_600) -> bytes:
    """A minimal valid mono PCM16 WAV (silence)."""
    import struct

    data = b"\x00\x00" * samples
    return (
        b"RIFF"
        + struct.pack("<I", 36 + len(data))
        + b"WAVEfmt "
        + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
        + b"data"
        + struct.pack("<I", len(data))
        + data
    )


def _capture_payload(**overrides) -> dict:
    import base64

    payload = {
        "wav_base64": base64.b64encode(_wav_bytes()).decode(),
        "sample_rate": 16_000,
        "provider": "gemini",
        "model": "gemini-live",
        "via_wake": True,
        "preroll_chunks": 2,
        "mic_chunks": 5,
        "seconds": 1.75,
        "outcome": "ok",
        "transcript": {"user": "what's on today", "assistant": "Two things."},
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def capture_env(voice_env, monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("MISSION_CONTROL_VOICE_DEBUG_CAPTURE_DIR", str(tmp_path))
    get_settings.cache_clear()
    return tmp_path


def test_debug_capture_writes_a_wav_and_json_sidecar(client: TestClient, capture_env) -> None:
    import json

    response = client.post("/api/voice/debug/capture", json=_capture_payload())
    assert response.status_code == 200
    written = response.json()["path"]
    assert written.endswith(".wav")

    wavs = list(capture_env.glob("*.wav"))
    jsons = list(capture_env.glob("*.json"))
    assert len(wavs) == 1 and len(jsons) == 1
    assert wavs[0].read_bytes() == _wav_bytes()
    # Filename is <stamp>-<kind>-<provider>.wav
    assert "-wake-gemini.wav" in wavs[0].name

    meta = json.loads(jsons[0].read_text())
    assert meta["provider"] == "gemini"
    assert meta["via_wake"] is True
    assert meta["transcript"]["user"] == "what's on today"
    assert meta["wav_file"] == wavs[0].name
    assert "wav_base64" not in meta


def test_debug_capture_prunes_to_the_keep_limit(
    client: TestClient, capture_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_DEBUG_CAPTURE_KEEP", "2")
    get_settings.cache_clear()

    for _ in range(4):
        assert client.post("/api/voice/debug/capture", json=_capture_payload()).status_code == 200

    assert len(list(capture_env.glob("*.wav"))) == 2
    assert len(list(capture_env.glob("*.json"))) == 2


def test_debug_capture_requires_voice_enabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    response = client.post("/api/voice/debug/capture", json=_capture_payload())
    assert response.status_code == 409


def test_debug_capture_can_be_switched_off(
    client: TestClient, capture_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_DEBUG_CAPTURE_ENABLED", "false")
    get_settings.cache_clear()
    response = client.post("/api/voice/debug/capture", json=_capture_payload())
    assert response.status_code == 409
    assert list(capture_env.glob("*")) == []


def test_debug_capture_rejects_a_non_wav_payload(client: TestClient, capture_env) -> None:
    import base64

    bad = base64.b64encode(b"not a riff file at all").decode()
    response = client.post("/api/voice/debug/capture", json=_capture_payload(wav_base64=bad))
    assert response.status_code == 422


def test_debug_capture_gated_to_local_network(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.delenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", raising=False)
    get_settings.cache_clear()
    response = client.post("/api/voice/debug/capture", json=_capture_payload())
    assert response.status_code == 403
