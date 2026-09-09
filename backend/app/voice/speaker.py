"""Backend bridge for the Wi-Fi speaker output path (kiosk → Invoke).

The mirror of :mod:`app.voice.wake_invoke`, one layer up: that module bridges the
Invoke gate's *control* socket; this one carries *audio*, in the opposite
direction from the mic path.

    mic   :  Invoke  →  VB-CABLE  →  the kiosk reads it as a microphone
    speaker:  the kiosk's output bus  →  WS /api/voice/speaker  →  here  →  TCP → Invoke

The kiosk sends **binary** WebSocket frames of signed 16-bit little-endian mono
PCM at 48 kHz — the whole echo-cancelled output bus (assistant replies, the
listening cue, the timer chime), tapped in the browser and summed there (see
``frontend/src/voice/speakerOut.ts``). This bridge widens each frame to the
S32LE / 48 kHz / 2 ch the device receiver's GStreamer caps demand
(``ReInvoke2026 output/invoke_speaker_daemon.sh``), applies an open-loop
clock-drift slip, and streams it to ``invoke_speaker_audio_port`` on the Invoke.
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
#: S16LE mono in, S32LE stereo out (the daemon's fixed caps).
_IN_BYTES_PER_FRAME = 2
_OUT_BYTES_PER_FRAME = 8

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


def _widen(pcm16_mono: bytes, slip: _DriftSlip) -> bytes:
    """S16LE mono bytes → S32LE interleaved-stereo bytes, with the drift slip.
    ``sample << 16`` is an exact left-justify into 32-bit; the daemon's softvol
    scales from there."""
    mono = array.array("h")
    mono.frombytes(pcm16_mono[: len(pcm16_mono) // 2 * 2])
    if sys.byteorder != "little":  # wire is little-endian
        mono.byteswap()
    mono = slip.apply(mono)
    stereo = array.array("i")
    for sample in mono:
        wide = sample << 16
        stereo.append(wide)
        stereo.append(wide)
    if sys.byteorder != "little":
        stereo.byteswap()
    return stereo.tobytes()


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
            note(f"voice speaker bridge: connected to {host}:{port}")
            async with lock:  # a reconnect costs one clean gap, not stale latency
                buffer.clear()
                have_audio.clear()
            try:
                writer.write(b"\x00" * (int(_PRIME_SECONDS * RATE) * _OUT_BYTES_PER_FRAME))
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
                writer.write(_widen(pending, slip))
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
