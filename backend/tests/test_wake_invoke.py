"""The ``invoke_gate`` wake bridge (``app/voice/wake_invoke.py`` + its route).

A fake asyncio TCP server stands in for the on-device ``invoke-gate`` control
socket. The bridge itself owns no keyword logic — these cover the guard, the
device -> kiosk frame forwarding, and the kiosk -> device command allow-list.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import get_settings
from app.main import app


class FakeGate:
    """A minimal invoke-gate control socket on its own background event loop."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._server: asyncio.AbstractServer | None = None
        self._writers: list[asyncio.StreamWriter] = []
        self.port: int = 0
        self.received: list[dict] = []
        self._ready = threading.Event()

    # -- lifecycle --
    def start(self) -> None:
        self._thread.start()
        assert self._ready.wait(timeout=5), "fake gate did not start"

    def stop(self) -> None:
        def _close() -> None:
            if self._server is not None:
                self._server.close()
            for writer in list(self._writers):
                writer.close()
            self._loop.stop()

        self._loop.call_soon_threadsafe(_close)
        self._thread.join(timeout=3)

    def _run(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._listen())
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            pending = asyncio.all_tasks(self._loop)
            for task in pending:
                task.cancel()
            self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            self._loop.close()

    async def _listen(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.append(writer)
        hello = {"t": "hello", "state": "off", "caps": ["gate_enabled"]}
        writer.write(json.dumps(hello).encode() + b"\n")
        await writer.drain()
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    self.received.append(json.loads(line))
                except ValueError:
                    pass
        finally:
            if writer in self._writers:
                self._writers.remove(writer)

    # -- test helpers --
    def emit(self, frame: dict) -> None:
        data = (json.dumps(frame) + "\n").encode()

        def _send() -> None:
            for w in list(self._writers):
                w.write(data)

        self._loop.call_soon_threadsafe(_send)

    def wait_connected(self, timeout: float = 2.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._writers:
                return
            time.sleep(0.02)
        raise AssertionError("bridge never connected to the fake gate")

    def wait_received(self, pred, timeout: float = 2.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for frame in list(self.received):
                if pred(frame):
                    return frame
            time.sleep(0.02)
        raise AssertionError(f"no matching command; got {self.received}")


@pytest.fixture
def fake_gate():
    gate = FakeGate()
    gate.start()
    yield gate
    gate.stop()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _enable(monkeypatch: pytest.MonkeyPatch, port: int) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST", "127.0.0.1")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_CONTROL_PORT", str(port))
    get_settings.cache_clear()


def test_bridge_forwards_device_frames(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_gate: FakeGate
) -> None:
    _enable(monkeypatch, fake_gate.port)
    with client.websocket_connect("/api/voice/wake/invoke") as ws:
        assert ws.receive_json()["t"] == "hello"
        fake_gate.emit({"t": "wake", "score": 1.0, "reason": "kws"})
        fake_gate.emit({"t": "state", "state": "open", "open": True, "reason": "kws"})
        kinds = {ws.receive_json()["t"] for _ in range(2)}
    assert kinds == {"wake", "state"}


def test_bridge_forwards_allowed_commands_and_drops_others(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_gate: FakeGate
) -> None:
    _enable(monkeypatch, fake_gate.port)
    with client.websocket_connect("/api/voice/wake/invoke") as ws:
        ws.receive_json()  # hello
        fake_gate.wait_connected()
        ws.send_json({"cmd": "done"})
        ws.send_json({"cmd": "rm-rf"})  # not allow-listed
        ws.send_json({"cmd": "gate_enabled", "on": True})
        fake_gate.wait_received(lambda f: f.get("cmd") == "gate_enabled")
    cmds = [f.get("cmd") for f in fake_gate.received]
    assert "done" in cmds and "gate_enabled" in cmds
    assert "rm-rf" not in cmds


def test_ws_refused_when_wake_or_voice_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_gate: FakeGate
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST", "127.0.0.1")
    get_settings.cache_clear()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/voice/wake/invoke"):
            pass


def test_ws_refused_when_host_unset(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_VOICE_ENABLED", "true")
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_ENABLED", "true")
    get_settings.cache_clear()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/voice/wake/invoke"):
            pass


def test_ws_refused_for_non_lan_client(
    monkeypatch: pytest.MonkeyPatch, fake_gate: FakeGate
) -> None:
    _enable(monkeypatch, fake_gate.port)
    monkeypatch.delenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", raising=False)
    get_settings.cache_clear()
    remote = TestClient(app, client=("8.8.8.8", 1234))
    with pytest.raises(WebSocketDisconnect):
        with remote.websocket_connect("/api/voice/wake/invoke"):
            pass
