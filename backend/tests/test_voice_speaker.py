"""The Wi-Fi speaker output bridge (``app/voice/speaker.py`` + its route).

A fake asyncio TCP server stands in for the on-device ``invoke_speaker_daemon.sh``
receiver. The bridge owns no audio semantics beyond format widening and the
open-loop drift slip — these cover the widening, the slip, the link-status
frame, and the route guard.
"""

from __future__ import annotations

import array
import asyncio
import struct
import threading
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import get_settings
from app.main import app
from app.voice.speaker import _DriftSlip, _encode

_PRIME_SAMPLES = int(0.06 * 48_000)  # silence lead the bridge sends on connect
_OUT_FRAME_BYTES = {"raw": 8, "s16": 4, "g711u": 2}
_SILENCE_BYTE_FOR = {"raw": b"\x00", "s16": b"\x00", "g711u": b"\xff"}


class FakeDaemon:
    """A minimal TCP sink on its own background event loop; records every byte."""

    def __init__(self) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._server: asyncio.AbstractServer | None = None
        self.port = 0
        self.data = bytearray()
        self._connected = threading.Event()
        self._ready = threading.Event()

    def start(self) -> None:
        self._thread.start()
        assert self._ready.wait(timeout=5), "fake daemon did not start"

    def stop(self) -> None:
        def _close() -> None:
            if self._server is not None:
                self._server.close()
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
        self._connected.set()
        try:
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                self.data.extend(chunk)
        finally:
            writer.close()

    def wait_connected(self, timeout: float = 2.0) -> None:
        assert self._connected.wait(timeout=timeout), "bridge never dialed the daemon"

    def wait_bytes(self, at_least: int, timeout: float = 2.0) -> bytes:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if len(self.data) >= at_least:
                return bytes(self.data)
            time.sleep(0.02)
        raise AssertionError(f"only {len(self.data)} bytes; wanted {at_least}")


@pytest.fixture
def fake_daemon():
    daemon = FakeDaemon()
    daemon.start()
    yield daemon
    daemon.stop()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _enable(monkeypatch: pytest.MonkeyPatch, port: int, ppm: str = "0",
            codec: str = "s16") -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_HOST", "127.0.0.1")
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_AUDIO_PORT", str(port))
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_DRIFT_PPM", ppm)
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_CODEC", codec)
    get_settings.cache_clear()


# -- pure helpers ------------------------------------------------------------


def test_encode_raw_mono_s16_to_stereo_s32_left_justified() -> None:
    mono = array.array("h", [0, 1, -2, 32767, -32768]).tobytes()
    out = _encode(mono, _DriftSlip(0.0), "raw")
    got = struct.unpack("<10i", out)
    assert got == (
        0, 0, 1 << 16, 1 << 16, -2 << 16, -2 << 16,
        32767 << 16, 32767 << 16, -32768 << 16, -32768 << 16,
    )


def test_encode_s16_mono_to_interleaved_stereo() -> None:
    mono = array.array("h", [0, 1, -2, 32767, -32768]).tobytes()
    out = _encode(mono, _DriftSlip(0.0), "s16")
    assert struct.unpack("<10h", out) == (0, 0, 1, 1, -2, -2, 32767, 32767, -32768, -32768)


def test_encode_raw_matches_reference_widen_across_the_range() -> None:
    # the vectorised little-endian path must equal `sample << 16`, both channels
    samples = list(range(-32768, 32768, 137)) + [-32768, -1, 0, 1, 32767]
    mono = array.array("h", samples)
    out = _encode(mono.tobytes(), _DriftSlip(0.0), "raw")
    got = struct.unpack(f"<{len(samples) * 2}i", out)
    expected = tuple(v << 16 for v in samples for _ in (0, 1))
    assert got == expected


def test_encode_g711u_matches_reference_and_is_stereo() -> None:
    import audioop  # noqa: PLC0415 - reference only, test-time

    mono = array.array("h", [0, 100, -100, 4000, -4000, 32767, -32768])
    out = _encode(mono.tobytes(), _DriftSlip(0.0), "g711u")
    ref = audioop.lin2ulaw(mono.tobytes(), 2)
    assert out[0::2] == ref and out[1::2] == ref          # both channels
    assert out[0:1] == b"\xff"                            # 0 -> canonical µ-law idle


def test_drift_slip_drops_samples_when_sink_is_fast() -> None:
    # +100000 ppm = drop 1 in 10; 100 samples -> ~90 out.
    slip = _DriftSlip(100_000.0)
    out = slip.apply(array.array("h", list(range(100))))
    assert 88 <= len(out) <= 92


def test_drift_slip_repeats_samples_when_sink_is_slow() -> None:
    slip = _DriftSlip(-100_000.0)
    out = slip.apply(array.array("h", list(range(100))))
    assert 108 <= len(out) <= 112


def test_zero_drift_is_identity() -> None:
    src = array.array("h", list(range(-50, 50)))
    assert _DriftSlip(0.0).apply(src) is src


# -- the bridge -------------------------------------------------------------


def test_bridge_encodes_and_forwards_audio(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_daemon: FakeDaemon
) -> None:
    _enable(monkeypatch, fake_daemon.port)  # default codec s16
    prime_bytes = _PRIME_SAMPLES * _OUT_FRAME_BYTES["s16"]
    payload = array.array("h", [100, -200, 300, -400]).tobytes()
    with client.websocket_connect("/api/voice/speaker") as ws:
        assert ws.receive_json()["t"] == "status"
        fake_daemon.wait_connected()
        ws.send_bytes(payload)
        raw = fake_daemon.wait_bytes(prime_bytes + 16)
    assert raw[:prime_bytes] == b"\x00" * prime_bytes  # silence prime
    tail = struct.unpack("<8h", raw[prime_bytes : prime_bytes + 16])
    assert tail == (100, 100, -200, -200, 300, 300, -400, -400)


def test_bridge_raw_codec_still_widens_to_s32(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_daemon: FakeDaemon
) -> None:
    _enable(monkeypatch, fake_daemon.port, codec="raw")
    prime_bytes = _PRIME_SAMPLES * _OUT_FRAME_BYTES["raw"]
    payload = array.array("h", [100, -200, 300, -400]).tobytes()
    with client.websocket_connect("/api/voice/speaker") as ws:
        assert ws.receive_json()["t"] == "status"
        fake_daemon.wait_connected()
        ws.send_bytes(payload)
        raw = fake_daemon.wait_bytes(prime_bytes + 32)
    assert raw[:prime_bytes] == b"\x00" * prime_bytes
    tail = struct.unpack("<8i", raw[prime_bytes : prime_bytes + 32])
    assert tail == (100 << 16, 100 << 16, -200 << 16, -200 << 16,
                    300 << 16, 300 << 16, -400 << 16, -400 << 16)


def _decode_as_daemon(payload: bytes, codec: str) -> array.array:
    """Interpret the wire bytes exactly as ``invoke_speaker_daemon.sh``'s
    capsfilter (+ mulawdec) would, and return the left channel as int16 — the
    mono signal that reaches the DAC. Proves the encoder and the device's
    declared format agree for real audio, not just 4-sample tails."""
    if codec == "raw":
        wide = list(struct.unpack(f"<{len(payload) // 4}i", payload))
        assert wide[0::2] == wide[1::2], "channels must be identical"
        return array.array("h", [s >> 16 for s in wide[0::2]])
    if codec == "s16":
        stereo = list(struct.unpack(f"<{len(payload) // 2}h", payload))
        assert stereo[0::2] == stereo[1::2]
        return array.array("h", stereo[0::2])
    import audioop  # noqa: PLC0415 - test-time reference decoder, == gst mulawdec

    assert payload[0::2] == payload[1::2]
    lin = audioop.ulaw2lin(bytes(payload[0::2]), 2)
    out = array.array("h")
    out.frombytes(lin)
    return out


@pytest.mark.parametrize("codec", ["raw", "s16", "g711u"])
def test_bridge_round_trips_a_real_signal_for_the_daemon(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_daemon: FakeDaemon, codec: str
) -> None:
    import math  # noqa: PLC0415

    _enable(monkeypatch, fake_daemon.port, codec=codec)
    prime_bytes = _PRIME_SAMPLES * _OUT_FRAME_BYTES[codec]
    src = array.array("h", [int(20000 * math.sin(i / 7.0)) for i in range(2400)])
    want_bytes = prime_bytes + len(src) * _OUT_FRAME_BYTES[codec]
    with client.websocket_connect("/api/voice/speaker") as ws:
        assert ws.receive_json()["t"] == "status"
        fake_daemon.wait_connected()
        ws.send_bytes(src.tobytes())
        raw = fake_daemon.wait_bytes(want_bytes)
    assert raw[:prime_bytes] == _SILENCE_BYTE_FOR[codec] * prime_bytes
    got = _decode_as_daemon(raw[prime_bytes:want_bytes], codec)
    assert len(got) == len(src)
    if codec == "g711u":  # lossy by design — check it is still the same waveform
        err = sum(abs(a - b) for a, b in zip(got, src, strict=True)) / len(src)
        assert err < 400  # µ-law step near 20k amplitude, not a broken decode
    else:
        assert got.tolist() == src.tolist()  # bit-exact


def test_default_codec_is_raw_s32(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_daemon: FakeDaemon
) -> None:
    # no MISSION_CONTROL_INVOKE_SPEAKER_CODEC set -> the daemon's built-in S32LE
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_HOST", "127.0.0.1")
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_AUDIO_PORT", str(fake_daemon.port))
    monkeypatch.delenv("MISSION_CONTROL_INVOKE_SPEAKER_CODEC", raising=False)
    get_settings.cache_clear()
    prime_bytes = _PRIME_SAMPLES * _OUT_FRAME_BYTES["raw"]
    payload = array.array("h", [100, -200, 300, -400]).tobytes()
    with client.websocket_connect("/api/voice/speaker") as ws:
        assert ws.receive_json()["t"] == "status"
        fake_daemon.wait_connected()
        ws.send_bytes(payload)
        raw = fake_daemon.wait_bytes(prime_bytes + 32)
    tail = struct.unpack("<8i", raw[prime_bytes : prime_bytes + 32])
    assert tail == (100 << 16, 100 << 16, -200 << 16, -200 << 16,
                    300 << 16, 300 << 16, -400 << 16, -400 << 16)


def test_first_status_frame_precedes_the_device_dial_out(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # host points at a black hole; the bridge must still greet the kiosk at once
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_HOST", "192.0.2.1")  # TEST-NET-1
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_AUDIO_PORT", "5006")
    get_settings.cache_clear()
    with client.websocket_connect("/api/voice/speaker") as ws:
        frame = ws.receive_json()
    assert frame["t"] == "status" and frame["link"] == "down"


def test_status_frame_reports_link_up(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_daemon: FakeDaemon
) -> None:
    _enable(monkeypatch, fake_daemon.port)
    with client.websocket_connect("/api/voice/speaker") as ws:
        seen = {ws.receive_json()["link"] for _ in range(2)}
    assert "up" in seen


def test_ws_refused_when_host_unset(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.delenv("MISSION_CONTROL_INVOKE_SPEAKER_HOST", raising=False)
    monkeypatch.delenv("MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST", raising=False)
    get_settings.cache_clear()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/voice/speaker"):
            pass


def test_ws_falls_back_to_gate_host(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, fake_daemon: FakeDaemon
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.delenv("MISSION_CONTROL_INVOKE_SPEAKER_HOST", raising=False)
    monkeypatch.setenv("MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST", "127.0.0.1")
    monkeypatch.setenv("MISSION_CONTROL_INVOKE_SPEAKER_AUDIO_PORT", str(fake_daemon.port))
    get_settings.cache_clear()
    with client.websocket_connect("/api/voice/speaker") as ws:
        assert ws.receive_json()["t"] == "status"
        fake_daemon.wait_connected()


def test_ws_refused_for_non_lan_client(
    monkeypatch: pytest.MonkeyPatch, fake_daemon: FakeDaemon
) -> None:
    _enable(monkeypatch, fake_daemon.port)
    monkeypatch.delenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", raising=False)
    get_settings.cache_clear()
    remote = TestClient(app, client=("8.8.8.8", 1234))
    with pytest.raises(WebSocketDisconnect):
        with remote.websocket_connect("/api/voice/speaker"):
            pass
