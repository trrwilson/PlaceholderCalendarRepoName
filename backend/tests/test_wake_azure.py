"""The ``azure`` wake provider's backend relay (``app/voice/wake_azure.py``).

The native Speech SDK is an optional dependency and does real keyword spotting
against a ``.table`` — neither is available in CI — so the SDK surface
``run_wake_relay`` touches is faked here. What is exercised is the relay's own
logic: arm the recogniser, stream client audio into the push stream, turn a
``recognized`` callback into a ``{"type": "wake"}`` frame, and re-arm.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import types
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.config import get_settings


class _Signal:
    def __init__(self) -> None:
        self._cbs: list = []

    def connect(self, cb) -> None:
        self._cbs.append(cb)

    def fire(self, evt) -> None:
        for cb in self._cbs:
            cb(evt)


class _FakePush:
    def __init__(self, stream_format=None) -> None:
        self.writes: list[bytes] = []
        self.closed = False

    def write(self, buffer: bytes) -> None:
        self.writes.append(buffer)

    def close(self) -> None:
        self.closed = True


class _FakeKeywordRecognizer:
    last: _FakeKeywordRecognizer | None = None

    def __init__(self, audio_config=None) -> None:
        self.audio_config = audio_config
        self.recognized = _Signal()
        self.canceled = _Signal()
        self.arm_calls = 0
        self.stopped = False
        _FakeKeywordRecognizer.last = self

    def recognize_once_async(self, model):
        self.arm_calls += 1
        return SimpleNamespace(get=lambda: None)

    def stop_recognition_async(self):
        self.stopped = True
        return SimpleNamespace(get=lambda: None)


@pytest.fixture
def fake_speechsdk(monkeypatch: pytest.MonkeyPatch):
    _FakeKeywordRecognizer.last = None
    speechsdk = types.ModuleType("azure.cognitiveservices.speech")
    speechsdk.ResultReason = SimpleNamespace(RecognizedKeyword="RecognizedKeyword")
    speechsdk.KeywordRecognitionModel = lambda path: ("model", path)
    speechsdk.KeywordRecognizer = _FakeKeywordRecognizer
    speechsdk.audio = SimpleNamespace(
        AudioStreamFormat=lambda **kw: ("fmt", kw),
        PushAudioInputStream=_FakePush,
        AudioConfig=lambda stream: ("cfg", stream),
    )
    azure_pkg = types.ModuleType("azure")
    cs_pkg = types.ModuleType("azure.cognitiveservices")
    monkeypatch.setitem(sys.modules, "azure", azure_pkg)
    monkeypatch.setitem(sys.modules, "azure.cognitiveservices", cs_pkg)
    monkeypatch.setitem(sys.modules, "azure.cognitiveservices.speech", speechsdk)
    get_settings.cache_clear()
    return speechsdk


class _FakeWS:
    """A minimal accepted client socket. ``script`` items are dicts to deliver as
    JSON frames, or callables invoked for their side effect (then a benign audio
    frame is delivered)."""

    def __init__(self, script: list) -> None:
        self._script = iter(script)
        self.sent: list[dict] = []
        self.application_state = WebSocketState.CONNECTED
        self.closed = False

    async def receive_text(self) -> str:
        await asyncio.sleep(0)  # let the other pump run
        try:
            item = next(self._script)
        except StopIteration:
            raise WebSocketDisconnect(code=1000) from None
        if callable(item):
            item()
            return json.dumps({"type": "audio", "pcm": ""})
        return json.dumps(item)

    async def send_json(self, payload: dict) -> None:
        await asyncio.sleep(0)
        self.sent.append(payload)

    async def close(self) -> None:
        self.closed = True
        self.application_state = WebSocketState.DISCONNECTED


async def test_relay_turns_a_recognition_into_a_wake_frame_and_re_arms(fake_speechsdk) -> None:
    from app.voice.wake_azure import run_wake_relay

    def detect() -> None:
        evt = SimpleNamespace(result=SimpleNamespace(reason="RecognizedKeyword"))
        _FakeKeywordRecognizer.last.recognized.fire(evt)

    ws = _FakeWS(
        [
            {"type": "audio", "pcm": "AAA="},
            detect,
            {"type": "audio", "pcm": ""},
            {"type": "audio", "pcm": ""},
        ]
    )
    await asyncio.wait_for(run_wake_relay(ws), timeout=2)

    assert {"type": "wake", "score": 1.0} in ws.sent
    assert {"type": "closing"} in ws.sent
    # armed once at start, once more after the detection
    assert _FakeKeywordRecognizer.last.arm_calls >= 2
    assert _FakeKeywordRecognizer.last.stopped is True


async def test_relay_ignores_a_non_keyword_result(fake_speechsdk) -> None:
    from app.voice.wake_azure import run_wake_relay

    def non_detect() -> None:
        evt = SimpleNamespace(result=SimpleNamespace(reason="NoMatch"))
        _FakeKeywordRecognizer.last.recognized.fire(evt)

    ws = _FakeWS([non_detect, {"type": "audio", "pcm": ""}])
    await asyncio.wait_for(run_wake_relay(ws), timeout=2)

    assert not any(m.get("type") == "wake" for m in ws.sent)


async def test_relay_forwards_audio_into_the_push_stream(fake_speechsdk) -> None:
    from app.voice.wake_azure import run_wake_relay

    payload = base64.b64encode(b"\x01\x02\x03\x04").decode()
    ws = _FakeWS(
        [
            {"type": "audio", "pcm": payload},
            {"type": "suspend"},
            {"type": "audio", "pcm": payload},
        ]
    )
    await asyncio.wait_for(run_wake_relay(ws), timeout=2)

    push = _FakeKeywordRecognizer.last.audio_config[1]  # ("cfg", <push stream>)
    # first frame written; the one after `suspend` is dropped
    assert push.writes == [b"\x01\x02\x03\x04"]
