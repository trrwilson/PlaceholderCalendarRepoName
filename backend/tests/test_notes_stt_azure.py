"""The ``azure`` notes-dictation provider's backend relay
(``app/notes_stt_azure.py``).

The native Speech SDK is an optional dependency and does real cloud
transcription — neither is available in CI — so the SDK surface
``run_notes_dictation_relay`` touches is faked here, mirroring
``test_wake_azure.py``'s approach for the sibling keyword-spotting relay.
What is exercised is the relay's own logic: stream client audio into the push
stream, turn ``recognizing``/``recognized`` callbacks into
``partial``/``final`` frames, close the push stream on ``stop``, and turn a
graceful end-of-stream into ``done`` (vs. a real cancellation into ``error``).
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

from app.config import Settings, get_settings


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


class _FakeSpeechRecognizer:
    last: _FakeSpeechRecognizer | None = None

    def __init__(self, speech_config=None, audio_config=None) -> None:
        self.speech_config = speech_config
        self.audio_config = audio_config
        self.recognizing = _Signal()
        self.recognized = _Signal()
        self.canceled = _Signal()
        self.session_stopped = _Signal()
        self.started = False
        self.stopped = False
        _FakeSpeechRecognizer.last = self

    def start_continuous_recognition_async(self):
        self.started = True
        return SimpleNamespace(get=lambda: None)

    def stop_continuous_recognition_async(self):
        self.stopped = True
        return SimpleNamespace(get=lambda: None)


@pytest.fixture
def fake_speechsdk(monkeypatch: pytest.MonkeyPatch):
    _FakeSpeechRecognizer.last = None
    speechsdk = types.ModuleType("azure.cognitiveservices.speech")
    speechsdk.ResultReason = SimpleNamespace(RecognizedSpeech="RecognizedSpeech", NoMatch="NoMatch")
    speechsdk.CancellationReason = SimpleNamespace(EndOfStream="EndOfStream", Error="Error")
    speechsdk.SpeechConfig = lambda **kw: ("speech_config", kw)
    speechsdk.SpeechRecognizer = _FakeSpeechRecognizer
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


def _settings(**overrides) -> Settings:
    return Settings(azure_speech_api_key="test-key", azure_speech_region="westus2", **overrides)


async def test_relay_forwards_partial_and_final_text(fake_speechsdk) -> None:
    from app.notes_stt_azure import run_notes_dictation_relay

    def speak() -> None:
        rec = _FakeSpeechRecognizer.last
        rec.recognizing.fire(SimpleNamespace(result=SimpleNamespace(text="pick up")))
        rec.recognizing.fire(SimpleNamespace(result=SimpleNamespace(text="pick up milk")))
        rec.recognized.fire(
            SimpleNamespace(result=SimpleNamespace(text="pick up milk", reason="RecognizedSpeech"))
        )

    def end_stream() -> None:
        _FakeSpeechRecognizer.last.canceled.fire(
            SimpleNamespace(reason="EndOfStream", error_details=None)
        )

    ws = _FakeWS(
        [
            {"type": "audio", "pcm": base64.b64encode(b"\x01\x02").decode()},
            speak,
            {"type": "stop"},
            end_stream,
        ]
    )
    await asyncio.wait_for(run_notes_dictation_relay(ws, _settings()), timeout=2)

    kinds = [m["type"] for m in ws.sent]
    assert kinds == ["partial", "partial", "final", "done"]
    assert ws.sent[1]["text"] == "pick up milk"
    assert ws.sent[2]["text"] == "pick up milk"
    push = _FakeSpeechRecognizer.last.audio_config[1]  # ("cfg", <push stream>)
    assert push.writes == [b"\x01\x02"]
    assert push.closed is True
    assert _FakeSpeechRecognizer.last.started is True
    assert _FakeSpeechRecognizer.last.stopped is True


async def test_relay_reports_a_real_cancellation_as_error(fake_speechsdk) -> None:
    from app.notes_stt_azure import run_notes_dictation_relay

    def fail() -> None:
        _FakeSpeechRecognizer.last.canceled.fire(
            SimpleNamespace(reason="Error", error_details="401: bad key")
        )

    ws = _FakeWS([fail, {"type": "audio", "pcm": ""}])
    await asyncio.wait_for(run_notes_dictation_relay(ws, _settings()), timeout=2)

    assert ws.sent[-1] == {
        "type": "error",
        "message": "Azure transcription error: 401: bad key",
    }


async def test_relay_a_recognized_nomatch_is_not_forwarded_as_final(fake_speechsdk) -> None:
    from app.notes_stt_azure import run_notes_dictation_relay

    def non_speech() -> None:
        rec = _FakeSpeechRecognizer.last
        rec.recognized.fire(SimpleNamespace(result=SimpleNamespace(text="", reason="NoMatch")))
        rec.canceled.fire(SimpleNamespace(reason="EndOfStream", error_details=None))

    ws = _FakeWS([non_speech, {"type": "audio", "pcm": ""}])
    await asyncio.wait_for(run_notes_dictation_relay(ws, _settings()), timeout=2)

    assert not any(m.get("type") == "final" for m in ws.sent)
    assert ws.sent[-1] == {"type": "done"}
