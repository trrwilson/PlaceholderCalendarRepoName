"""Backend bridge for the additive on-device Invoke gate.

The gate is not a wake provider — it sits in front of whichever provider
(``openwakeword`` / ``azure``) is selected; see ``app.voice.wake`` and
``wakeword/MC_INTEGRATION.md``.

The on-device ``invoke-gate`` daemon (ReInvoke2026 ``wakeword/``, see
``wakeword/PROTOCOL.md``) serves a newline-delimited JSON *control* socket on a
LAN TCP port. A browser cannot open a raw TCP socket, so — exactly as
:mod:`app.voice.wake_azure` relays keyword detection — this module bridges the
daemon's control channel to the kiosk over ``WS /api/voice/wake/invoke``:

* device -> kiosk: ``hello`` / ``wake`` / ``state`` / ``preroll`` / ``vad`` /
  ``closing`` / ``heartbeat`` / ``error`` frames, forwarded as text unchanged.
* kiosk -> device: ``{"cmd": ...}`` commands, forwarded after an allow-list
  check (``ptt_start`` / ``ptt_stop`` / ``hold`` / ``done`` / ``set`` /
  ``gate_enabled`` / ``keepalive``).

No authentication (resolution 1 in ``FIRST_STAGE_WAKEWORD_INVESTIGATION.md`` —
the client and the LAN are trusted). The daemon's **audio** socket (``:5004``)
is *not* touched here: that PCM goes to VB-CABLE and the kiosk reads it from the
microphone exactly as today; this side carries only control.

The bridge reconnects to the daemon with backoff while the kiosk WS stays up and
surfaces a link-down as a synthetic ``{"t": "error", "message": "gate link
down"}`` frame so the kiosk can fall back to push-to-talk.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.config import get_settings
from app.voice.trace import note

# Commands the kiosk is allowed to send through to the daemon. Anything else is
# dropped silently (the daemon would ignore it anyway; this keeps the bridge a
# narrow, auditable surface).
_ALLOWED_CMDS = frozenset(
    {"ptt_start", "ptt_stop", "hold", "done", "set", "gate_enabled", "keepalive"}
)

_RECONNECT_BACKOFF_S = (0.5, 1.0, 2.0, 4.0, 8.0)


async def _safe_send_text(ws: WebSocket, text: str) -> None:
    try:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_text(text)
    except Exception:  # noqa: BLE001 - best effort; the socket is going away
        pass


async def run_invoke_wake_relay(client: WebSocket) -> None:
    """Bridge the kiosk WS <-> the invoke-gate control socket until either closes.

    ``client`` must already be ``accept``-ed.
    """
    settings = get_settings()
    host = settings.wake_word_invoke_gate_host
    port = settings.wake_word_invoke_gate_control_port

    # kiosk -> device commands are queued so a brief device reconnect does not
    # drop one that arrived mid-gap.
    outbound: asyncio.Queue[str] = asyncio.Queue()

    async def _pump_client() -> None:
        while True:
            raw = await client.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                continue
            cmd = frame.get("cmd")
            if not isinstance(cmd, str) or cmd not in _ALLOWED_CMDS:
                continue
            await outbound.put(json.dumps(frame, separators=(",", ":")))

    async def _bridge_device() -> None:
        attempt = 0
        while True:
            try:
                reader, writer = await asyncio.open_connection(host, port)
            except OSError as exc:
                await _safe_send_text(
                    client,
                    json.dumps({"t": "error", "message": f"gate link down: {exc}"}),
                )
                delay = _RECONNECT_BACKOFF_S[min(attempt, len(_RECONNECT_BACKOFF_S) - 1)]
                attempt += 1
                await asyncio.sleep(delay)
                continue
            attempt = 0
            note(f"invoke wake bridge: connected to {host}:{port}")
            try:
                await _relay_one_connection(reader, writer, client, outbound)
            finally:
                writer.close()
                with contextlib.suppress(Exception):
                    await writer.wait_closed()
            await _safe_send_text(client, json.dumps({"t": "error", "message": "gate link down"}))
            await asyncio.sleep(_RECONNECT_BACKOFF_S[0])

    tasks = [
        asyncio.create_task(_pump_client()),
        asyncio.create_task(_bridge_device()),
    ]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect | asyncio.CancelledError):
                note(f"invoke wake bridge: {exc!r}")
    finally:
        with contextlib.suppress(Exception):
            if client.application_state == WebSocketState.CONNECTED:
                await client.close()


async def _relay_one_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    client: WebSocket,
    outbound: asyncio.Queue[str],
) -> None:
    """Pump one live daemon connection both ways until it or the socket breaks."""

    async def _device_to_kiosk() -> None:
        while True:
            line = await reader.readline()
            if not line:  # the daemon closed the connection
                return
            text = line.decode("utf-8", "replace").strip()
            if text:
                await _safe_send_text(client, text)

    async def _kiosk_to_device() -> None:
        while True:
            payload = await outbound.get()
            writer.write(payload.encode("utf-8") + b"\n")
            await writer.drain()

    pair = [
        asyncio.create_task(_device_to_kiosk()),
        asyncio.create_task(_kiosk_to_device()),
    ]
    try:
        await asyncio.wait(pair, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in pair:
            task.cancel()
        await asyncio.gather(*pair, return_exceptions=True)
