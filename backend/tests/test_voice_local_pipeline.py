"""The local voice pipeline: grant, WS transport, text-bypass endpoint, gates.

Uses the dependency-free scripted recogniser (``MISSION_CONTROL_LOCAL_STT_ENGINE=null``)
so nothing here needs an STT model.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def local_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_PROVIDER", "local")
    monkeypatch.setenv("MISSION_CONTROL_LOCAL_STT_ENGINE", "null")
    get_settings.cache_clear()


# -- grant --------------------------------------------------------------


def test_local_grant_is_a_single_use_ticket(client: TestClient, local_env: None) -> None:
    body = client.post("/api/voice/token").json()
    assert body["provider"] == "local"
    assert body["endpointing"] == "client"
    assert body["token"]  # a relay-style ticket
    assert "scripted" in body["model"] or "faster-whisper" in body["model"]


def test_local_provider_listed_and_selectable(client: TestClient, local_env: None) -> None:
    cfg = client.get("/api/voice/config").json()
    assert cfg["provider"] == "local"
    ids = {p["id"] for p in cfg["providers"]}
    assert "local" in ids
    local = next(p for p in cfg["providers"] if p["id"] == "local")
    assert local["implemented"] and local["configured"]


# -- text-bypass interpret endpoint -----------------------------------


def test_interpret_endpoint_handles_navigation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    body = client.post("/api/voice/local/interpret", json={"text": "show me the month"}).json()
    assert body["disposition"] == "handled_locally"
    assert body["tool_calls"][0]["name"] == "show_view"
    assert body["tool_calls"][0]["args"]["view"] == "month"


def test_interpret_endpoint_available_without_voice_enabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    # voice_enabled is false by default — the text bypass still answers
    resp = client.post("/api/voice/local/interpret", json={"text": "what's on tomorrow"})
    assert resp.status_code == 200


def test_interpret_endpoint_is_lan_gated(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "false")
    get_settings.cache_clear()
    with TestClient(app, client=("8.8.8.8", 1234)) as remote:
        resp = remote.post("/api/voice/local/interpret", json={"text": "show the week"})
    assert resp.status_code == 403


def test_interpret_endpoint_flags_escalation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    get_settings.cache_clear()
    body = client.post(
        "/api/voice/local/interpret",
        json={"text": "when can we all have dinner together this week without any clashes"},
    ).json()
    assert body["disposition"] == "escalate_to_cloud"
    assert body["escalation"]["transcript"]


# -- the WebSocket pipeline (scripted recogniser) --------------------


def test_ws_text_frame_drives_tools(client: TestClient, local_env: None) -> None:
    grant = client.post("/api/voice/token").json()
    with client.websocket_connect(f"/api/voice/local?ticket={grant['token']}") as ws:
        assert ws.receive_json()["type"] == "open"
        ws.send_json({"type": "text", "text": "show me the week"})
        events = _drain(ws)
    types = [e["type"] for e in events]
    assert "user-transcript" in types
    assert "diagnostic" in types
    tool_calls = [e for e in events if e["type"] == "tool-call"]
    assert any(t["name"] == "show_view" for t in tool_calls)
    assert "generation-complete" in types


def test_ws_audio_then_activity_end_finalises(client: TestClient, local_env: None) -> None:
    import base64

    grant = client.post("/api/voice/token").json()
    silence = base64.b64encode(b"\x00\x00" * 1600).decode()
    with client.websocket_connect(f"/api/voice/local?ticket={grant['token']}") as ws:
        ws.receive_json()  # open
        ws.send_json({"type": "activity-start"})
        ws.send_json({"type": "audio", "data": silence})
        ws.send_json({"type": "activity-end"})
        events = _drain(ws)
    # scripted recogniser yields an empty transcript -> a clean empty turn
    types = [e["type"] for e in events]
    assert "generation-complete" in types


def test_ws_rejects_a_bad_ticket(client: TestClient, local_env: None) -> None:
    with pytest.raises(Exception):  # noqa: B017 - starlette raises on the 4401 close
        with client.websocket_connect("/api/voice/local?ticket=nope") as ws:
            ws.receive_json()


def test_ws_is_lan_gated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_PROVIDER", "local")
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "false")
    get_settings.cache_clear()
    with TestClient(app, client=("8.8.8.8", 1234)) as remote, pytest.raises(Exception):  # noqa: B017
        with remote.websocket_connect("/api/voice/local?ticket=x") as ws:
            ws.receive_json()


def _drain(ws, limit: int = 40) -> list[dict]:
    out: list[dict] = []
    for _ in range(limit):
        try:
            event = ws.receive_json()
        except Exception:
            break
        out.append(event)
        if event["type"] in ("turn-complete",):
            break
    return out
