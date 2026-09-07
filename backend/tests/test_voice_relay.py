"""Azure voice contestants: adapter grants + the relay translation.

The relay's live behaviour against real Azure endpoints is unverified (see
``docs/voice-provider-bakeoff-plan.md``); these cover the parts that are pure
logic — the grant/ticket handshake and the bidirectional protocol translation —
plus the LAN gate on the relay socket.
"""

from __future__ import annotations

import json
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import get_settings
from app.main import app
from app.voice.providers import get_adapter
from app.voice.relay import (
    UpstreamConfig,
    _RelayTurn,
    issue_ticket,
    redeem_ticket,
    translate_client,
    translate_upstream,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def azure_openai_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_PROVIDER", "azure_openai_realtime")
    monkeypatch.setenv(
        "MISSION_CONTROL_AZURE_OPENAI_ENDPOINT", "https://unit-test.openai.azure.com"
    )
    monkeypatch.setenv("MISSION_CONTROL_AZURE_OPENAI_API_KEY", "azkey")
    get_settings.cache_clear()


# -- translation -------------------------------------------------------------


def test_translate_upstream_maps_the_realtime_events_we_care_about() -> None:
    assert translate_upstream({"type": "session.updated"}) == [{"type": "open"}]
    assert translate_upstream(
        {"type": "conversation.item.input_audio_transcription.delta", "delta": "what's "}
    ) == [{"type": "user-transcript", "text": "what's ", "final": False}]
    assert translate_upstream(
        {"type": "conversation.item.input_audio_transcription.completed", "transcript": "what's up"}
    ) == [{"type": "user-transcript", "text": "what's up", "final": True}]
    # The provider VAD's endpoint signals are forwarded so the kiosk can end the
    # turn on the semantic endpoint rather than a raw-energy guess.
    assert translate_upstream({"type": "input_audio_buffer.speech_started"}) == [
        {"type": "speech-started"}
    ]
    assert translate_upstream({"type": "input_audio_buffer.speech_stopped"}) == [
        {"type": "speech-stopped"}
    ]
    # Both the GA event names (Azure OpenAI Realtime `/openai/v1`) and the
    # flat/beta ones (Voice Live) map to the same VoiceEvent.
    assert translate_upstream({"type": "response.output_audio.delta", "delta": "AAA="}) == [
        {"type": "audio", "data": "AAA="}
    ]
    assert translate_upstream({"type": "response.audio.delta", "delta": "AAA="}) == [
        {"type": "audio", "data": "AAA="}
    ]
    assert translate_upstream(
        {"type": "response.output_audio_transcript.delta", "delta": "Two "}
    ) == [{"type": "assistant-transcript", "text": "Two "}]
    assert translate_upstream({"type": "response.audio_transcript.delta", "delta": "Two "}) == [
        {"type": "assistant-transcript", "text": "Two "}
    ]
    assert translate_upstream(
        {
            "type": "response.function_call_arguments.done",
            "call_id": "call_1",
            "name": "get_agenda",
            "arguments": '{"date": "2026-09-06"}',
        }
    ) == [
        {"type": "tool-call", "id": "call_1", "name": "get_agenda", "args": {"date": "2026-09-06"}}
    ]
    assert translate_upstream({"type": "response.done"}) == [
        {"type": "generation-complete"},
        {"type": "turn-complete"},
    ]
    assert translate_upstream({"type": "error", "error": {"message": "boom"}}) == [
        {"type": "error", "message": "boom"}
    ]
    # A commit that raced the provider's own VAD is not a turn failure.
    assert (
        translate_upstream(
            {"type": "error", "error": {"code": "input_audio_buffer_commit_empty", "message": "x"}}
        )
        == []
    )
    # Anything we do not translate is dropped, not forwarded raw.
    assert translate_upstream({"type": "rate_limits.updated"}) == []


def test_a_response_with_tool_calls_does_not_end_the_turn_and_batches_one_answer() -> None:
    """The bug: one `response.create` per tool output races the still-generating
    response and aborts the turn ("let me check the calendar" cut off). Fix: hold
    `generation-complete` for a call-making response, and send exactly one
    follow-up `response.create` once every output is in."""
    turn = _RelayTurn()

    # The model speaks, then calls two tools, then finishes that response.
    assert translate_upstream({"type": "response.output_audio.delta", "delta": "AA"}, turn) == [
        {"type": "audio", "data": "AA"}
    ]
    for cid, name in (("c1", "get_agenda"), ("c2", "show_view")):
        out = translate_upstream(
            {"type": "response.function_call_arguments.done", "call_id": cid, "name": name},
            turn,
        )
        assert out[0]["type"] == "tool-call"
    # `response.done` for that response must NOT reach the kiosk as end-of-turn.
    assert translate_upstream({"type": "response.done"}, turn) == []
    assert turn.response_done is True and turn.awaiting == {"c1", "c2"}

    # First tool answered — still waiting on the other, so no follow-up yet.
    translate_client({"type": "tool-response", "id": "c1", "output": {"ok": True}}, turn=turn)
    assert not turn.follow_up_ready()
    # Second answered — now the single follow-up is due.
    translate_client({"type": "tool-response", "id": "c2", "output": {"ok": True}}, turn=turn)
    assert turn.follow_up_ready()

    # The *answer* response makes no calls, so it ends the turn normally.
    turn.clear_round()
    assert translate_upstream({"type": "response.done"}, turn) == [
        {"type": "generation-complete"},
        {"type": "turn-complete"},
    ]


def test_a_runaway_tool_loop_is_flagged_for_cancellation() -> None:
    """Seen live: `gpt-realtime` on Voice Live called get_events ~25x in one
    response. Past the cap the relay cancels it (once)."""
    from app.voice.relay import _MAX_TOOL_CALLS_PER_RESPONSE, _maybe_break_tool_loop

    turn = _RelayTurn()
    for i in range(_MAX_TOOL_CALLS_PER_RESPONSE + 1):
        translate_upstream(
            {
                "type": "response.function_call_arguments.done",
                "call_id": f"c{i}",
                "name": "get_events",
            },
            turn,
        )
    assert turn.calls == _MAX_TOOL_CALLS_PER_RESPONSE + 1

    sent: list[dict] = []

    class _Up:
        async def send(self, data: str) -> None:
            sent.append(json.loads(data))

    import asyncio

    asyncio.run(_maybe_break_tool_loop(_Up(), turn))
    asyncio.run(_maybe_break_tool_loop(_Up(), turn))  # idempotent
    assert sent == [{"type": "response.cancel"}]
    assert turn.cancelled is True


def test_translate_upstream_tolerates_bad_tool_arguments() -> None:
    out = translate_upstream(
        {
            "type": "response.function_call_arguments.done",
            "call_id": "c",
            "name": "x",
            "arguments": "{",
        }
    )
    assert out == [{"type": "tool-call", "id": "c", "name": "x", "args": {}}]


def test_translate_client_brackets_a_manual_turn() -> None:
    assert translate_client({"type": "audio", "data": "QQ=="}) == [
        {"type": "input_audio_buffer.append", "audio": "QQ=="}
    ]
    # Fresh session per turn — `activity-start` has nothing to do.
    assert translate_client({"type": "activity-start"}) == []
    # `client` / `hybrid`: the kiosk owns the turn boundary — `activity-end`
    # commits and asks for the reply.
    assert translate_client({"type": "activity-end"}) == [
        {"type": "input_audio_buffer.commit"},
        {"type": "response.create"},
    ]
    assert translate_client({"type": "activity-end"}, turn=_RelayTurn(endpointing="hybrid")) == [
        {"type": "input_audio_buffer.commit"},
        {"type": "response.create"},
    ]
    # `provider`: the provider VAD triggers the reply on its own endpoint, so
    # `activity-end` only commits.
    assert translate_client({"type": "activity-end"}, turn=_RelayTurn(endpointing="provider")) == [
        {"type": "input_audio_buffer.commit"}
    ]
    # A tool response only adds the output item; the single `response.create` for
    # the round is sent separately once every output is in (see the batching test).
    # `output` arrives already serialised (the realtime function_call_output
    # contract) and is passed through, not re-wrapped.
    tool = translate_client(
        {"type": "tool-response", "id": "call_1", "name": "get_agenda", "output": '{"events": []}'}
    )
    assert tool == [
        {
            "type": "conversation.item.create",
            "item": {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": '{"events": []}',
            },
        }
    ]


# -- tickets ---------------------------------------------------------------


def test_relay_ticket_is_single_use_and_expires() -> None:
    cfg = UpstreamConfig(provider="azure_voice_live", url="wss://x", headers={}, session_update={})
    token = issue_ticket(cfg, ttl_seconds=60)
    assert redeem_ticket(token) is cfg
    # Spent — a replay gets nothing.
    assert redeem_ticket(token) is None
    assert redeem_ticket(issue_ticket(cfg, ttl_seconds=-1)) is None
    assert redeem_ticket(None) is None


# -- adapter grants ------------------------------------------------------------


async def _grant(calendar_names: list[str] | None = None):
    settings = get_settings()
    adapter = get_adapter(settings)
    return adapter, await adapter.create_grant(
        settings,
        calendar_names=calendar_names or ["Travis", "Sam"],
        surface="kitchen",
        now_local=datetime(2026, 9, 6, 18, 30),
        timezone="America/Los_Angeles",
    )


async def test_azure_openai_realtime_grant_and_ticket(azure_openai_env) -> None:
    _, grant = await _grant()
    assert grant.provider == "azure_openai_realtime"
    assert grant.model == "gpt-realtime-2.1"
    assert grant.endpointing == "hybrid"
    assert grant.surface == "kitchen"

    cfg = redeem_ticket(grant.token)
    assert cfg is not None
    # GA `/openai/v1` surface: OpenAI-parity, no api-version, model= (not deployment=).
    assert cfg.url == "wss://unit-test.openai.azure.com/openai/v1/realtime?model=gpt-realtime-2.1"
    assert "api-version" not in cfg.url
    assert cfg.headers == {"api-key": "azkey"}
    session = cfg.session_update
    assert session["type"] == "realtime"
    assert session["output_modalities"] == ["audio"]
    # Default `hybrid`: semantic VAD runs for streaming ASR + `speech_stopped`
    # but does not create the response — the kiosk owns that (and ends the turn
    # on the forwarded `speech_stopped`, with a mic-RMS backstop).
    assert session["audio"]["input"]["turn_detection"] == {
        "type": "semantic_vad",
        "create_response": False,
    }
    assert session["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
    assert session["audio"]["output"]["voice"] == "marin"
    # The default transcribe deployment is wired in for the user transcript.
    assert session["audio"]["input"]["transcription"] == {"model": "gpt-4o-transcribe"}
    assert {t["name"] for t in session["tools"]} == {
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
    }
    assert "Travis, Sam" in session["instructions"]
    assert "September 6, 2026 at 6:30 PM" in session["instructions"]


def test_azure_key_falls_back_to_the_shared_foundry_env_var(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MISSION_CONTROL_AZURE_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("MISSION_CONTROL_AZURE_VOICE_LIVE_API_KEY", raising=False)
    monkeypatch.setenv("FOUNDRY_API_KEY_MC_EASTUS2", "shared-foundry-key")
    get_settings.cache_clear()
    settings = get_settings()
    assert settings.azure_openai_api_key == "shared-foundry-key"
    assert settings.azure_voice_live_api_key == "shared-foundry-key"


async def test_azure_openai_realtime_mini_uses_the_mini_deployment(
    azure_openai_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_PROVIDER", "azure_openai_realtime_mini")
    get_settings.cache_clear()
    _, grant = await _grant()
    assert grant.provider == "azure_openai_realtime_mini"
    assert grant.model == "gpt-realtime-2.1-mini"
    assert redeem_ticket(grant.token).url.endswith(
        "/openai/v1/realtime?model=gpt-realtime-2.1-mini"
    )


async def test_azure_openai_realtime_includes_a_transcribe_deployment_when_set(
    azure_openai_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT", "my-transcribe")
    get_settings.cache_clear()
    _, grant = await _grant()
    session = redeem_ticket(grant.token).session_update
    assert session["audio"]["input"]["transcription"] == {"model": "my-transcribe"}


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("client", None),
        ("hybrid", {"type": "semantic_vad", "create_response": False}),
        ("provider", {"type": "semantic_vad", "create_response": True}),
    ],
)
async def test_azure_openai_realtime_endpointing_selects_turn_detection(
    azure_openai_env, monkeypatch: pytest.MonkeyPatch, mode: str, expected
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_AZURE_OPENAI_REALTIME_ENDPOINTING", mode)
    get_settings.cache_clear()
    _, grant = await _grant()
    assert grant.endpointing == mode
    cfg = redeem_ticket(grant.token)
    assert cfg.endpointing == mode
    assert cfg.session_update["audio"]["input"]["turn_detection"] == expected


async def test_azure_voice_live_grant_carries_the_speech_extras(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_PROVIDER", "azure_voice_live")
    monkeypatch.setenv(
        "MISSION_CONTROL_AZURE_VOICE_LIVE_ENDPOINT", "https://westus.api.cognitive.microsoft.com"
    )
    monkeypatch.setenv("MISSION_CONTROL_AZURE_VOICE_LIVE_API_KEY", "vlkey")
    get_settings.cache_clear()

    _, grant = await _grant()
    assert grant.provider == "azure_voice_live"
    assert grant.endpointing == "hybrid"
    cfg = redeem_ticket(grant.token)
    assert cfg.endpointing == "hybrid"
    # Voice Live is a separate product: it keeps api-version + model in the URL.
    assert "/voice-live/realtime?" in cfg.url
    assert "api-version=2026-07-15" in cfg.url
    assert "model=gpt-realtime" in cfg.url
    session = cfg.session_update
    # ...and the flat/beta session shape: `modalities`, a `voice` object.
    assert session["modalities"] == ["text", "audio"]
    assert session["voice"] == {"name": "en-GB-SoniaNeural", "type": "azure-standard"}
    # VAD stays in the session (its EC needs it) but does not create the response
    # — the kiosk drives that.
    assert session["turn_detection"]["type"] == "azure_semantic_vad"
    assert session["turn_detection"]["create_response"] is False
    assert session["input_audio_noise_reduction"] == {"type": "azure_deep_noise_suppression"}
    assert session["input_audio_echo_cancellation"] == {"type": "server_echo_cancellation"}


def test_relay_grants_are_never_cached_so_each_turn_gets_a_fresh_ticket(
    client: TestClient, azure_openai_env
) -> None:
    """The token cache would hand the same single-use ticket to a second turn,
    which the relay then 4401s. Relay providers must mint fresh every request."""
    first = client.post("/api/voice/token").json()
    second = client.post("/api/voice/token").json()
    assert first["provider"] == "azure_openai_realtime"
    assert first["token"] != second["token"]
    # Both tickets are live and independent.
    assert redeem_ticket(first["token"]) is not None
    assert redeem_ticket(second["token"]) is not None


# -- relay socket gate -------------------------------------------------------


def test_voice_live_socket_rejects_a_missing_or_bad_ticket(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/api/voice/live?ticket=nope"),
    ):
        pass


class _ScriptedUpstream:
    """A fake provider socket: replays ``script`` to the relay, records what the
    relay sends up."""

    def __init__(self, script: list[dict]) -> None:
        self._script = script
        self.sent: list[dict] = []

    async def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    def __aiter__(self) -> _ScriptedUpstream:
        self._it = iter(self._script)
        return self

    async def __anext__(self) -> str:
        try:
            return json.dumps(next(self._it))
        except StopIteration:
            raise StopAsyncIteration from None


class _FakeConnect:
    def __init__(self, upstream: _ScriptedUpstream) -> None:
        self._upstream = upstream

    async def __aenter__(self) -> _ScriptedUpstream:
        return self._upstream

    async def __aexit__(self, *_: object) -> bool:
        return False


def test_relay_bridges_a_turn_end_to_end_with_a_fake_upstream(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()

    upstream = _ScriptedUpstream(
        [
            {"type": "session.updated"},
            {"type": "response.output_audio.delta", "delta": "AQID"},
            {"type": "response.output_audio_transcript.delta", "delta": "Two things"},
            {"type": "response.done"},
        ]
    )
    monkeypatch.setattr("websockets.connect", lambda *a, **k: _FakeConnect(upstream))

    session = {"instructions": "hi", "tools": [], "voice": "marin"}
    cfg = UpstreamConfig(
        provider="azure_openai_realtime",
        url="wss://x",
        headers={"api-key": "k"},
        session_update=session,
    )
    token = issue_ticket(cfg, ttl_seconds=60)

    received: list[dict] = []
    with client.websocket_connect(f"/api/voice/live?ticket={token}") as ws:
        try:
            while True:
                received.append(ws.receive_json())
        except WebSocketDisconnect:
            pass

    kinds = [frame["type"] for frame in received]
    assert kinds == [
        "open",
        "audio",
        "assistant-transcript",
        "generation-complete",
        "turn-complete",
        "closing",
    ]
    assert received[1]["data"] == "AQID"
    # The relay configured the session upstream before pumping.
    assert upstream.sent[0] == {"type": "session.update", "session": session}


def test_voice_live_socket_is_lan_gated(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", raising=False)
    get_settings.cache_clear()
    cfg = UpstreamConfig(provider="azure_voice_live", url="wss://x", headers={}, session_update={})
    token = issue_ticket(cfg, ttl_seconds=60)
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(f"/api/voice/live?ticket={token}"),
    ):
        pass
    # The ticket was never redeemed (gate ran first), so it is still good.
    assert redeem_ticket(token) is cfg
