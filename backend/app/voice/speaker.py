"""Backend bridge for the Wi-Fi speaker output path (kiosk → Invoke).

The mirror of :mod:`app.voice.wake_invoke`, one layer up: that module bridges the
Invoke gate's *control* socket; this one carries *audio*, in the opposite
direction from the mic path.

    mic   :  Invoke  →  VB-CABLE  →  the kiosk reads it as a microphone
    speaker:  the kiosk's output bus  →  WS /api/voice/speaker  →  here  →  TCP → Invoke

The kiosk sends **binary** WebSocket frames of signed 16-bit little-endian mono
PCM at 48 kHz — the whole echo-cancelled output bus (assistant replies, the
listening cue, the timer chime), tapped in the browser and summed there (see
``frontend/src/voice/speakerOut.ts``). This bridge applies an open-loop
clock-drift slip, encodes each frame to the wire format the device receiver is
decoding (``invoke_speaker_codec`` — ``s16`` S16LE/48k/2ch by default, or
``g711u`` µ-law / ``raw`` S32LE; MUST equal the daemon's ``SPK_CODEC`` in
``ReInvoke2026 output/invoke_speaker_daemon.sh`` — there is no control channel,
so a mismatch plays back garbled and slow), and streams it to
``invoke_speaker_audio_port`` on the Invoke.
The device is the TCP server; we dial out, exactly like the ReInvoke2026 feeder.

WHY NOT AN OS VIRTUAL AUDIO DEVICE
---------------------------------
The ReInvoke2026 ``invoke_speaker_feeder.py`` needs a second VB-CABLE / Voicemeeter
endpoint only because it is a generic WASAPI-capture tool with no other way in.
Mission Control generates its own output audio and already bridges browser sockets
to this box, so it feeds the daemon directly. The daemon is unchanged.

CLOCK DRIFT
-----------
The browser render clock and the Invoke DAC are independent crystals (~30 ppm).
The device side free-runs at the DAC (``alsasink sync=false``); correction must
happen upstream. This bridge does the ReInvoke2026 plan's open-loop scheme: a
periodic single-sample slip sized by ``MISSION_CONTROL_INVOKE_SPEAKER_DRIFT_PPM``
(default 0). Residual drift is an occasional inaudible slip in the device buffer.
A closed loop would need device-side buffer telemetry — future work, same as the
mic gate's control channel.

No authentication (the client and the LAN are trusted, as for the wake bridge).
Loopback / LAN only — enforced by the route guard in ``app.api``.
"""

from __future__ import annotations

import array
import asyncio
import contextlib
import json
import sys
import time

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.config import Settings
from app.voice.trace import note

RATE = 48_000
#: S16LE mono in; the wire format out depends on ``invoke_speaker_codec`` and
#: MUST match the device daemon's ``SPK_CODEC``.
_IN_BYTES_PER_FRAME = 2
#: bytes per output (stereo) frame, per codec
_OUT_FRAME_BYTES = {"raw": 8, "s16": 4, "g711u": 2}
#: the byte the device buffer reads as digital silence, per codec
_SILENCE_BYTE = {"raw": b"\x00", "s16": b"\x00", "g711u": b"\xff"}

#: A brief silence lead on every (re)connect so the device queue / ALSA ring
#: never starts from empty and clicks. Matches the feeder's ``PRIME_SILENCE_S``.
_PRIME_SECONDS = 0.06
#: Drop the oldest audio once more than this is buffered unsent — a sustained
#: network stall, not normal jitter. The device-side queue is the real buffer.
_MAX_BUFFER_BYTES = RATE * _IN_BYTES_PER_FRAME * 35 // 100  # ~350 ms
_RECONNECT_BACKOFF_S = (0.5, 1.0, 2.0, 4.0, 8.0)
_STATUS_INTERVAL_S = 5.0


def resolve_speaker_host(settings: Settings) -> str:
    """The Invoke host for the speaker path: its own setting, else the shared
    Invoke-gate host so one ``…INVOKE…HOST`` configures both directions."""
    return settings.invoke_speaker_host or settings.wake_word_invoke_gate_host


def speaker_configured(settings: Settings) -> bool:
    """True once an Invoke host is known — Settings then offers the "Invoke"
    output. Reachability of the daemon is surfaced at connect time as a status
    frame, exactly like the wake relay's ``error`` frame."""
    return bool(resolve_speaker_host(settings))


class _DriftSlip:
    """Open-loop resampling by whole-sample slip. ``ppm`` positive ⇒ the sink
    (Invoke DAC) is faster than the source, so we must emit fewer samples: drop
    one every ``1e6 / ppm``. Negative ⇒ repeat one. Sub-sample error accumulates
    in ``_acc`` and never exceeds one sample."""

    def __init__(self, ppm: float) -> None:
        self._step = ppm / 1e6
        self._acc = 0.0

    def apply(self, mono: array.array) -> array.array:
        if self._step == 0.0 or not mono:
            return mono
        out = array.array("h")
        for sample in mono:
            self._acc += self._step
            if self._acc >= 1.0:  # sink fast → drop this sample
                self._acc -= 1.0
                continue
            out.append(sample)
            if self._acc <= -1.0:  # sink slow → emit it twice
                self._acc += 1.0
                out.append(sample)
        return out


_ULAW_TABLE: bytes | None = None


def _ulaw_table() -> bytes:
    """uint16 index (an int16 sample) → G.711 µ-law byte. Bit-exact port of
    CPython audioop's ``st_14linear2ulaw`` (== ``audioop.lin2ulaw``), so the
    device's gst ``mulawdec`` decodes it as standard G.711. Built once, lazily
    (only the ``g711u`` codec needs it)."""
    global _ULAW_TABLE
    if _ULAW_TABLE is not None:
        return _ULAW_TABLE
    seg_uend = (0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF)
    out = bytearray(65536)
    for u in range(65536):
        s = u - 65536 if u >= 32768 else u          # uint16 -> int16
        x = s >> 2                                   # 16-bit -> 14-bit
        mask = 0x7F if x < 0 else 0xFF
        x = min(abs(x), 32635) + (0x84 >> 2)         # CLIP + (BIAS >> 2)
        seg = next((i for i, e in enumerate(seg_uend) if x <= e), 8)
        if seg >= 8:
            out[u] = (0x7F ^ mask) & 0xFF
        else:
            out[u] = (((seg << 4) | ((x >> (seg + 1)) & 0xF)) ^ mask) & 0xFF
    _ULAW_TABLE = bytes(out)
    return _ULAW_TABLE


def _encode(pcm16_mono: bytes, slip: _DriftSlip, codec: str) -> bytes:
    """S16LE mono bytes → wire bytes for ``codec``, drift slip applied first:

    * ``raw``   — S32LE interleaved stereo (``sample << 16`` left-justify)
    * ``s16``   — S16LE interleaved stereo
    * ``g711u`` — G.711 µ-law interleaved stereo (1 byte/sample)
    """
    mono = array.array("h")
    mono.frombytes(pcm16_mono[: len(pcm16_mono) // 2 * 2])
    if sys.byteorder != "little":  # wire is little-endian
        mono.byteswap()
    mono = slip.apply(mono)

    if codec == "raw":
        # S32LE, sample left-justified (<< 16). On a little-endian host that is
        # exactly the interleaved int16 pair (0, sample) per channel, so slice
        # assignment fills it with no per-sample Python loop and the encode adds
        # no measurable latency to the real-time pump. Big-endian hosts (rare for
        # this service) keep the explicit widen.
        if sys.byteorder == "little":
            stereo16 = array.array("h", bytes(len(mono) * 8))
            stereo16[1::4] = mono  # left channel, high half
            stereo16[3::4] = mono  # right channel, high half
            return stereo16.tobytes()
        stereo = array.array("i")
        for sample in mono:
            wide = sample << 16
            stereo.append(wide)
            stereo.append(wide)
        stereo.byteswap()
        return stereo.tobytes()

    if codec == "s16":
        stereo = array.array("h", bytes(len(mono) * 4))
        stereo[0::2] = mono
        stereo[1::2] = mono
        if sys.byteorder != "little":
            stereo.byteswap()
        return stereo.tobytes()

    # g711u
    table = _ulaw_table()
    enc = bytes(table[sample & 0xFFFF] for sample in mono)
    stereo = bytearray(len(enc) * 2)
    stereo[0::2] = enc
    stereo[1::2] = enc
    return bytes(stereo)


async def _safe_send_text(ws: WebSocket, text: str) -> None:
    try:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_text(text)
    except Exception:  # noqa: BLE001 - best effort; the socket is going away
        pass


async def run_speaker_bridge(client: WebSocket, settings: Settings) -> None:
    """Pump the kiosk's output-bus audio to the Invoke speaker daemon until
    either side closes. ``client`` must already be ``accept``-ed."""
    host = resolve_speaker_host(settings)
    port = settings.invoke_speaker_audio_port
    slip = _DriftSlip(settings.invoke_speaker_drift_ppm)
    codec = settings.invoke_speaker_codec
    if codec not in _OUT_FRAME_BYTES:  # unknown value → behave as if unset
        codec = "s16"
    prime = _SILENCE_BYTE[codec] * (int(_PRIME_SECONDS * RATE) * _OUT_FRAME_BYTES[codec])

    buffer = bytearray()
    have_audio = asyncio.Event()
    lock = asyncio.Lock()
    stats = {"sent_bytes": 0, "sheds": 0, "reconnects": 0, "link": "down"}

    async def _pump_client() -> None:
        while True:
            chunk = await client.receive_bytes()
            if not chunk:
                continue
            async with lock:
                buffer.extend(chunk)
                if len(buffer) > _MAX_BUFFER_BYTES:
                    del buffer[: len(buffer) - _MAX_BUFFER_BYTES // 2]
                    stats["sheds"] += 1
                have_audio.set()

    async def _bridge_device() -> None:
        attempt = 0
        while True:
            try:
                reader, writer = await asyncio.open_connection(host, port)
            except OSError as exc:
                stats["link"] = "down"
                await _send_status(f"connect failed: {exc}")
                delay = _RECONNECT_BACKOFF_S[min(attempt, len(_RECONNECT_BACKOFF_S) - 1)]
                attempt += 1
                await asyncio.sleep(delay)
                continue
            attempt = 0
            stats["link"] = "up"
            note(f"voice speaker bridge: connected to {host}:{port} (codec {codec})")
            async with lock:  # a reconnect costs one clean gap, not stale latency
                buffer.clear()
                have_audio.clear()
            try:
                writer.write(prime)
                await writer.drain()
                await _send_status("streaming")
                await _drain_to_device(reader, writer)
            except OSError as exc:
                note(f"voice speaker bridge: send error ({exc})")
            finally:
                writer.close()
                with contextlib.suppress(Exception):
                    await writer.wait_closed()
            stats["link"] = "down"
            stats["reconnects"] += 1
            await _send_status("device link dropped")
            await asyncio.sleep(_RECONNECT_BACKOFF_S[0])

    async def _drain_to_device(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            await have_audio.wait()
            async with lock:
                pending = bytes(buffer)
                buffer.clear()
                have_audio.clear()
            if pending:
                writer.write(_encode(pending, slip, codec))
                await writer.drain()
                stats["sent_bytes"] += len(pending)
            if reader.at_eof():  # the daemon closed the socket
                return

    async def _status_ticker() -> None:
        while True:
            await asyncio.sleep(_STATUS_INTERVAL_S)
            await _send_status()

    async def _send_status(detail: str = "") -> None:
        await _safe_send_text(
            client,
            json.dumps(
                {
                    "t": "status",
                    "link": stats["link"],
                    "sent_s": round(stats["sent_bytes"] / (RATE * _IN_BYTES_PER_FRAME), 1),
                    "sheds": stats["sheds"],
                    "reconnects": stats["reconnects"],
                    "detail": detail,
                    "at": round(time.time(), 3),
                },
                separators=(",", ":"),
            ),
        )

    # An immediate frame so the kiosk shows "connecting" (and keeps local playout
    # audible) from the first moment, not only once the device dial-out resolves
    # — which can take the full TCP timeout when the Invoke is unreachable.
    await _send_status("connecting")

    tasks = [
        asyncio.create_task(_pump_client()),
        asyncio.create_task(_bridge_device()),
        asyncio.create_task(_status_ticker()),
    ]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect | asyncio.CancelledError):
                note(f"voice speaker bridge: {exc!r}")
    finally:
        with contextlib.suppress(Exception):
            if client.application_state == WebSocketState.CONNECTED:
                await client.close()
