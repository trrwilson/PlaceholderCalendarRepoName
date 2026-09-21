"""Real-time Azure Speech transcription for the Home notes pane's push-to-talk
text field — the streaming sibling of ``app/notes_stt.py``'s one-shot
providers (``gemini``, ``local``), and the only notes-dictation path that
reports interim ("hypothesis") text while the person is still speaking
rather than a single result at the end.

Wire protocol (JSON text frames over ``WS /api/notes/dictate/azure``, the
same shape as the Azure wake relay in ``app/voice/wake_azure.py``):

* client -> backend: ``{"type": "audio", "pcm": "<base64 PCM16 16 kHz mono>"}``,
  ``{"type": "stop"}`` (recording ended — finish and report).
* backend -> client: ``{"type": "partial", "text": ...}`` (interim
  hypothesis, replaces the previous partial), ``{"type": "final", "text":
  ...}`` (one recognised segment — the client concatenates these itself, this
  module never assembles a whole-utterance transcript), ``{"type": "done"}``
  (no more results are coming), ``{"type": "error", "message": ...}``.

Uses the same native Speech SDK as the ``azure`` wake-word provider
(``azure-cognitiveservices-speech``, the ``azure-wake`` optional dependency)
but ``SpeechRecognizer`` continuous recognition against Microsoft's cloud
Speech service, not the offline, on-device ``KeywordRecognizer`` — so unlike
wake-word spotting, this path does send mic audio to Azure (see
``app.notes_stt``'s provider docstring for why notes dictation is its own
switch from the conversational assistant).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.config import Settings
from app.voice.trace import note

# 16 kHz mono PCM16 — fixed by the frontend downsample, matching every other
# mic-streaming relay in this backend (wake word, voice local pipeline).
_SAMPLE_RATE = 16_000


async def _safe_send_json(ws: WebSocket, payload: dict) -> None:
    try:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_json(payload)
    except Exception:  # noqa: BLE001 - best effort; the socket is going away
        pass


async def run_notes_dictation_relay(client: WebSocket, settings: Settings) -> None:
    """Stream one push-to-talk utterance to Azure Speech and relay its
    interim/final recognition events back to the kiosk.

    ``client`` must already be ``accept``-ed. Returns when the socket closes
    or the recogniser reports a terminal result.
    """
    import azure.cognitiveservices.speech as speechsdk

    loop = asyncio.get_running_loop()
    events: asyncio.Queue[dict] = asyncio.Queue()

    speech_config = speechsdk.SpeechConfig(
        subscription=settings.azure_speech_api_key, region=settings.azure_speech_region
    )
    stream_format = speechsdk.audio.AudioStreamFormat(
        samples_per_second=_SAMPLE_RATE, bits_per_sample=16, channels=1
    )
    push_stream = speechsdk.audio.PushAudioInputStream(stream_format=stream_format)
    audio_config = speechsdk.audio.AudioConfig(stream=push_stream)
    recognizer = speechsdk.SpeechRecognizer(speech_config=speech_config, audio_config=audio_config)

    def _on_recognizing(evt: speechsdk.SpeechRecognitionEventArgs) -> None:
        text = evt.result.text
        if text:
            loop.call_soon_threadsafe(events.put_nowait, {"type": "partial", "text": text})

    def _on_recognized(evt: speechsdk.SpeechRecognitionEventArgs) -> None:
        if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
            loop.call_soon_threadsafe(events.put_nowait, {"type": "final", "text": evt.result.text})

    def _on_canceled(evt: speechsdk.SpeechRecognitionCanceledEventArgs) -> None:
        # `EndOfStream` is the expected, non-error way this ends: the client
        # sent "stop", we closed `push_stream`, and the SDK ran out of audio.
        if evt.reason == speechsdk.CancellationReason.EndOfStream:
            loop.call_soon_threadsafe(events.put_nowait, {"type": "done"})
            return
        detail = evt.error_details or str(evt.reason)
        loop.call_soon_threadsafe(
            events.put_nowait, {"type": "error", "message": f"Azure transcription error: {detail}"}
        )

    def _on_session_stopped(evt: object) -> None:
        loop.call_soon_threadsafe(events.put_nowait, {"type": "done"})

    recognizer.recognizing.connect(_on_recognizing)
    recognizer.recognized.connect(_on_recognized)
    recognizer.canceled.connect(_on_canceled)
    recognizer.session_stopped.connect(_on_session_stopped)

    recognizer.start_continuous_recognition_async().get()
    note("notes dictation relay: azure continuous recognition started")

    async def _pump_client() -> None:
        while True:
            raw = await client.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = frame.get("type")
            if kind == "audio":
                pcm = frame.get("pcm")
                if isinstance(pcm, str) and pcm:
                    with contextlib.suppress(Exception):
                        push_stream.write(base64.b64decode(pcm))
            elif kind == "stop":
                with contextlib.suppress(Exception):
                    push_stream.close()

    async def _pump_events() -> None:
        while True:
            event = await events.get()
            await _safe_send_json(client, event)
            if event["type"] in ("done", "error"):
                return

    client_task = asyncio.create_task(_pump_client())
    events_task = asyncio.create_task(_pump_events())
    try:
        done, pending = await asyncio.wait(
            [client_task, events_task], return_when=asyncio.FIRST_COMPLETED
        )
        if events_task in pending:
            # `client_task` ended first (the browser disconnected) — a
            # terminal event fired via `call_soon_threadsafe` in the same
            # instant is only *scheduled*, not yet in the queue, so give
            # `events_task` one brief grace window to receive and forward it
            # before giving up on it.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(events_task, timeout=0.2)
        for task in (client_task, events_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(client_task, events_task, return_exceptions=True)
        for task in (client_task, events_task):
            if task.cancelled():
                continue
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                note(f"notes dictation relay: {exc!r}")
    finally:
        with contextlib.suppress(Exception):
            recognizer.stop_continuous_recognition_async().get()
        with contextlib.suppress(Exception):
            push_stream.close()
        with contextlib.suppress(Exception):
            if client.application_state == WebSocketState.CONNECTED:
                await client.close()
