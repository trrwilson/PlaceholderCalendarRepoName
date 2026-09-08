"""Backend wake-word detection for the ``azure`` provider.

The JavaScript Speech SDK cannot load a custom-keyword ``.table`` (its
``KeywordRecognitionModel`` factories are unimplemented stubs), so — unlike the
in-browser ``openwakeword`` detector — the kiosk cannot spot an Azure keyword on
its own. Instead the browser streams 16 kHz mono PCM16 to
``WS /api/voice/wake/azure`` and this module runs the native SDK's
``KeywordRecognizer`` against the ``.table``. Keyword spotting is fully
on-device: no Azure subscription key, no network. Only the audio crosses to the
backend (localhost / LAN — the same trust boundary as ``app/voice/relay.py``).

Wire protocol (JSON text frames):

* client -> backend: ``{"type": "audio", "pcm": "<base64 PCM16 16 kHz mono>"}``,
  ``{"type": "suspend"}`` (a voice turn is running — stop feeding the recogniser),
  ``{"type": "resume"}``.
* backend -> client: ``{"type": "wake", "score": <float>}`` on a detection,
  ``{"type": "error", "message": ...}`` if the recogniser fails.

The frontend owns the post-detection cooldown and the pre-roll buffer, exactly
as it does for ``openwakeword``; this side only answers "was the phrase just
said?".
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.config import get_settings
from app.voice.trace import note

# 16 kHz mono PCM16 — fixed by the frontend downsample (`downsampleTo16k`) and
# what Azure custom-keyword models expect.
_SAMPLE_RATE = 16_000


async def _safe_send_json(ws: WebSocket, payload: dict) -> None:
    try:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_json(payload)
    except Exception:  # noqa: BLE001 - best effort; the socket is going away
        pass


async def run_wake_relay(client: WebSocket) -> None:
    """Spot the wake phrase in the kiosk's mic stream until either side closes.

    ``client`` must already be ``accept``-ed. Returns when the socket closes or
    the recogniser reports an unrecoverable error.
    """
    import azure.cognitiveservices.speech as speechsdk

    settings = get_settings()
    loop = asyncio.get_running_loop()
    events: asyncio.Queue[dict] = asyncio.Queue()

    stream_format = speechsdk.audio.AudioStreamFormat(
        samples_per_second=_SAMPLE_RATE, bits_per_sample=16, channels=1
    )
    push_stream = speechsdk.audio.PushAudioInputStream(stream_format=stream_format)
    audio_config = speechsdk.audio.AudioConfig(stream=push_stream)

    try:
        model = speechsdk.KeywordRecognitionModel(settings.wake_word_azure_model_path)
    except Exception as exc:  # noqa: BLE001 - a bad/missing .table is a config error
        note(f"wake relay: could not load keyword model: {exc}")
        await _safe_send_json(
            client, {"type": "error", "message": f"keyword model unavailable: {exc}"}
        )
        with contextlib.suppress(Exception):
            await client.close()
        return

    recognizer = speechsdk.KeywordRecognizer(audio_config)
    # Keep a reference to the in-flight recognition future so it is not GC'd
    # mid-operation. The `recognized` signal, not the future, is what we act on.
    pending: list[object] = []

    def _on_recognized(evt: speechsdk.KeywordRecognitionEventArgs) -> None:
        recognised = getattr(evt.result, "reason", None) == speechsdk.ResultReason.RecognizedKeyword
        if recognised:
            loop.call_soon_threadsafe(events.put_nowait, {"type": "wake"})

    def _on_canceled(evt: object) -> None:
        loop.call_soon_threadsafe(
            events.put_nowait, {"type": "error", "message": f"keyword recogniser canceled: {evt}"}
        )

    recognizer.recognized.connect(_on_recognized)
    recognizer.canceled.connect(_on_canceled)

    def _arm() -> None:
        pending.clear()
        pending.append(recognizer.recognize_once_async(model))

    _arm()
    note("wake relay: azure keyword recogniser armed")

    async def _pump_client() -> None:
        suspended = False
        while True:
            raw = await client.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = frame.get("type")
            if kind == "audio":
                if suspended:
                    continue
                pcm = frame.get("pcm")
                if isinstance(pcm, str) and pcm:
                    with contextlib.suppress(Exception):
                        push_stream.write(base64.b64decode(pcm))
            elif kind == "suspend":
                suspended = True
            elif kind == "resume":
                suspended = False

    async def _pump_events() -> None:
        while True:
            event = await events.get()
            if event["type"] == "wake":
                await _safe_send_json(client, {"type": "wake", "score": 1.0})
                # `recognize_once_async` completes on the first hit — re-arm so
                # the next "Mission Control" is heard too.
                _arm()
            else:
                await _safe_send_json(client, event)
                return

    tasks = [asyncio.create_task(_pump_client()), asyncio.create_task(_pump_events())]
    try:
        done, pending_tasks = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending_tasks:
            task.cancel()
        await asyncio.gather(*pending_tasks, return_exceptions=True)
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect | asyncio.CancelledError):
                note(f"wake relay: {exc!r}")
    finally:
        with contextlib.suppress(Exception):
            recognizer.stop_recognition_async().get()
        with contextlib.suppress(Exception):
            push_stream.close()
        await _safe_send_json(client, {"type": "closing"})
        with contextlib.suppress(Exception):
            if client.application_state == WebSocketState.CONNECTED:
                await client.close()
