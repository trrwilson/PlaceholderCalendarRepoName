"""Backend WebSocket relay for the Azure voice contestants.

Azure Voice Live and Azure OpenAI Realtime both speak the OpenAI realtime
session protocol, and neither can be opened browser-direct (the browser
``WebSocket`` API cannot set the ``api-key`` / ``Authorization`` header). So the
kiosk connects to our own ``WS /api/voice/live`` with a single-use ticket, and
this module:

* holds the upstream socket with the server-side credentials, and
* translates between the provider's realtime protocol and Mission Control's
  shared ``VoiceEvent`` protocol (the same JSON the frontend
  ``ConversationalVoiceProvider`` consumes) in both directions.

That keeps "shared conversational semantics above provider protocols"
(``AGENTS.md`` -> "Voice assistant -> Provider architecture"): a future
local/hybrid backend can reuse this exact relay contract.

End-of-speech ownership is **negotiated per provider** (``UpstreamConfig.endpointing``;
see ``docs/voice-provider-bakeoff-plan.md`` -> "End-of-speech ownership"):

* ``client`` — ``turn_detection: null`` upstream; the kiosk brackets the turn
  with ``activity-start`` / ``activity-end`` and this relay turns ``activity-end``
  into ``commit`` + ``response.create``.
* ``hybrid`` — a provider VAD runs (``semantic_vad`` / ``azure_semantic_vad``)
  with ``create_response: false``; its ``speech_started`` / ``speech_stopped`` are
  forwarded so the kiosk endpoints on the semantic endpoint instead of a
  raw-energy guess, and ``activity-end`` still drives ``commit`` + ``response.create``.
* ``provider`` — the provider VAD runs with ``create_response: true`` and answers
  on its own endpoint; ``activity-end`` only commits (no ``response.create``).

UNVERIFIED against live Azure resources — see
``docs/voice-provider-bakeoff-plan.md``.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from dataclasses import dataclass, field

from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.voice.trace import note

# -- ticket store ----------------------------------------------------------------
# A ticket is minted into the grant and spent (once) to open the relay socket
# seconds later. Process-memory, like the timer store and the token cache.


@dataclass(frozen=True)
class UpstreamConfig:
    """Everything the relay needs to open and configure one provider socket."""

    provider: str
    url: str
    headers: dict[str, str]
    #: the ``session`` object sent as a ``session.update`` immediately on connect
    session_update: dict
    #: end-of-speech ownership (see the module docstring). ``client`` / ``hybrid``
    #: -> the kiosk's ``activity-end`` asks for the reply; ``provider`` -> the
    #: provider answers on its own VAD endpoint and ``activity-end`` only commits.
    endpointing: str = "client"


@dataclass
class _Ticket:
    config: UpstreamConfig
    expires_at: float  # time.monotonic()


_TICKETS: dict[str, _Ticket] = {}


def _prune() -> None:
    now = time.monotonic()
    for token in [t for t, ticket in _TICKETS.items() if ticket.expires_at < now]:
        _TICKETS.pop(token, None)


def issue_ticket(config: UpstreamConfig, ttl_seconds: int) -> str:
    _prune()
    token = secrets.token_urlsafe(24)
    _TICKETS[token] = _Ticket(config, time.monotonic() + ttl_seconds)
    return token


def redeem_ticket(token: str | None) -> UpstreamConfig | None:
    """Return the config for ``token`` and invalidate it (single use)."""
    _prune()
    if not token:
        return None
    ticket = _TICKETS.pop(token, None)
    if ticket is None or ticket.expires_at < time.monotonic():
        return None
    return ticket.config


def reset_relay_tickets() -> None:
    _TICKETS.clear()


def to_wss(endpoint: str) -> str:
    """``https://host`` (or ``http://``) -> ``wss://host`` (or ``ws://``), no trailing slash."""
    return endpoint.rstrip("/").replace("https://", "wss://").replace("http://", "ws://")


# -- session config ------------------------------------------------------------
# The two Azure products diverge here. Azure OpenAI Realtime is on the GA
# `/openai/v1` surface (OpenAI-parity: `session.type`, `output_modalities`,
# nested `audio.input`/`audio.output`). Azure Voice Live is a separate product
# still on the flat/beta shape (`modalities`, a `voice` object, flat
# `turn_detection`) and its own `api-version`.
#
# `turn_detection` is chosen by the adapter from its `endpointing` mode (see
# `openai_turn_detection` / `voice_live_turn_detection`), not hard-coded here.


def openai_turn_detection(endpointing: str) -> dict | None:
    """The GA `audio.input.turn_detection` for an end-of-speech mode.

    `client` -> null (the kiosk's mic-RMS detector is the whole endpointer).
    `hybrid` -> `semantic_vad` with `create_response: false` (streaming ASR +
    a forwarded `speech_stopped`; the kiosk still owns the reply).
    `provider` -> `semantic_vad` with `create_response: true` (the model answers
    on its own endpoint).
    """
    if endpointing == "client":
        return None
    return {"type": "semantic_vad", "create_response": endpointing == "provider"}


def voice_live_turn_detection(endpointing: str) -> dict:
    """`azure_semantic_vad` is always present for Voice Live (its echo canceller
    requires it); only `create_response` moves with the mode."""
    return {
        "type": "azure_semantic_vad",
        "silence_duration_ms": 500,
        "create_response": endpointing == "provider",
    }


def build_openai_ga_session(
    *,
    instructions: str,
    tools: list[dict],
    voice: str,
    turn_detection: dict | None,
    transcribe_deployment: str = "",
) -> dict:
    """The GA `/openai/v1` realtime ``session`` object (Azure OpenAI Realtime)."""
    audio_input: dict = {
        "format": {"type": "audio/pcm", "rate": 24_000},
        "turn_detection": turn_detection,
    }
    if transcribe_deployment:
        audio_input["transcription"] = {"model": transcribe_deployment}
    return {
        "type": "realtime",
        "instructions": instructions,
        "output_modalities": ["audio"],
        "audio": {
            "input": audio_input,
            "output": {"voice": voice, "format": {"type": "audio/pcm", "rate": 24_000}},
        },
        "tools": tools,
        "tool_choice": "auto",
    }


def build_voice_live_session(
    *,
    instructions: str,
    tools: list[dict],
    voice: str,
    voice_type: str,
    transcription_model: str,
    turn_detection: dict | None = None,
    extras: dict | None = None,
) -> dict:
    """The flat Voice Live ``session`` object (`voice` is an object here).

    ``turn_detection`` **must** be set — Voice Live rejects server-side echo
    cancellation "when turn detection is disabled" and then kills the session, so
    ``client`` end-of-speech is not available for this product. In ``hybrid``
    (the default) ``create_response`` is off: the VAD runs for the audio pipeline
    and emits ``speech_stopped``, but the kiosk owns the reply (commit +
    response.create on ``activity-end``). ``provider`` flips ``create_response``
    on. (Verified live: semantic VAD alone never endpoints a hesitant speaker,
    and won't fire without words at all — hence the kiosk backstop in ``hybrid``.)
    """
    session: dict = {
        "modalities": ["text", "audio"],
        "instructions": instructions,
        "voice": {"name": voice, "type": voice_type},
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm16",
        "input_audio_transcription": {"model": transcription_model},
        "turn_detection": turn_detection or voice_live_turn_detection("hybrid"),
        "tools": tools,
        "tool_choice": "auto",
    }
    if extras:
        session.update(extras)
    return session


# -- protocol translation ------------------------------------------------------

_BENIGN_ERROR_CODES = frozenset(
    {
        "input_audio_buffer_commit_empty",
        "response_cancel_not_active",
    }
)


@dataclass
class _RelayTurn:
    """Per-connection state for the one part the realtime protocol can't express
    statelessly: a response that makes function calls is **not** the end of the
    turn. The model speaks (maybe), calls tools, and finishes that response; only
    after we feed the outputs back and it produces a *second* response with no
    calls is the turn actually done.

    So we withhold ``generation-complete`` / ``turn-complete`` for a response that
    made calls, and send exactly one ``response.create`` once every output for it
    is in — not one per tool (which races the still-generating response and is
    what aborted "let me check the calendar" mid-sentence).
    """

    awaiting: set[str] = field(default_factory=set)  # call_ids forwarded, no output yet
    made_calls: bool = False  # the in-flight response emitted >= 1 function call
    response_done: bool = False  # ...and that response has finished
    calls: int = 0  # function calls in the in-flight response (runaway guard)
    cancelled: bool = False  # we sent response.cancel to break a tool loop
    #: end-of-speech ownership for this connection (see the module docstring).
    #: In ``provider`` mode the provider VAD triggers the reply itself, so
    #: ``activity-end`` must not also send ``response.create``.
    endpointing: str = "client"

    def follow_up_ready(self) -> bool:
        return self.made_calls and self.response_done and not self.awaiting

    def clear_round(self) -> None:
        self.awaiting.clear()
        self.made_calls = False
        self.response_done = False
        self.calls = 0
        self.cancelled = False


#: A single response calling more tools than this is looping (seen live: 25x
#: get_events). Cancel it and ask for a plain answer with what we have.
_MAX_TOOL_CALLS_PER_RESPONSE = 8


def translate_upstream(event: dict, turn: _RelayTurn | None = None) -> list[dict]:
    """One provider realtime event -> zero or more Mission Control ``VoiceEvent``s.

    Accepts both the GA event names (`response.output_audio.delta`) and the
    flat/beta ones (`response.audio.delta`) so one translator serves both Azure
    products. ``turn`` carries the function-call round state (see ``_RelayTurn``).
    """
    turn = turn if turn is not None else _RelayTurn()
    kind = event.get("type")
    if kind == "session.updated":
        # "config applied, ready" — not `session.created`, which is just "socket up".
        return [{"type": "open"}]
    if kind == "conversation.item.input_audio_transcription.delta":
        return [{"type": "user-transcript", "text": event.get("delta", ""), "final": False}]
    if kind in (
        "conversation.item.input_audio_transcription.completed",
        "conversation.item.audio_transcription.completed",
    ):
        return [{"type": "user-transcript", "text": event.get("transcript", ""), "final": True}]
    if kind == "input_audio_buffer.speech_started":
        return [{"type": "speech-started"}]
    if kind == "input_audio_buffer.speech_stopped":
        # The provider VAD's semantic endpoint. In `hybrid` mode `create_response`
        # is off, so this is the kiosk's cue to end the user's turn — it still
        # sends `activity-end` itself, which commits the buffer and asks for the
        # reply. In `provider` mode the reply is already on its way.
        return [{"type": "speech-stopped"}]
    if kind in ("response.output_audio.delta", "response.audio.delta"):
        return [{"type": "audio", "data": event.get("delta", "")}]
    if kind in ("response.output_audio_transcript.delta", "response.audio_transcript.delta"):
        return [{"type": "assistant-transcript", "text": event.get("delta", "")}]
    if kind == "response.function_call_arguments.done":
        try:
            args = json.loads(event.get("arguments") or "{}")
        except (json.JSONDecodeError, TypeError):
            args = {}
        call_id = event.get("call_id") or event.get("item_id") or ""
        turn.made_calls = True
        turn.calls += 1
        turn.awaiting.add(call_id)
        return [{"type": "tool-call", "id": call_id, "name": event.get("name", ""), "args": args}]
    if kind == "response.done":
        if turn.made_calls:
            # Not the end of the turn — the answer response is still to come.
            turn.response_done = True
            return []
        return [{"type": "generation-complete"}, {"type": "turn-complete"}]
    if kind == "error":
        err = event.get("error") if isinstance(event.get("error"), dict) else {}
        if err.get("code") in _BENIGN_ERROR_CODES:
            return []
        return [{"type": "error", "message": err.get("message") or "voice provider error"}]
    return []


def translate_client(event: dict, *, turn: _RelayTurn | None = None) -> list[dict]:
    """One Mission Control uplink frame -> zero or more provider realtime events.

    For ``client`` / ``hybrid`` end-of-speech the kiosk owns the turn boundary: on
    ``activity-end`` it commits the buffer and asks for the reply. (A provider VAD
    may still run in ``hybrid`` — for streaming ASR / the echo canceller — but
    with ``create_response`` off, so we decide when the reply happens.) In
    ``provider`` mode the provider VAD triggers the reply on its own endpoint, so
    ``activity-end`` only commits.
    """
    turn = turn if turn is not None else _RelayTurn()
    kind = event.get("type")
    if kind == "audio":
        return [{"type": "input_audio_buffer.append", "audio": event.get("data", "")}]
    if kind == "activity-start":
        # Fresh session per turn — the buffer is already empty; nothing to do.
        return []
    if kind == "activity-end":
        # Finalise the user's turn. The commit is best-effort — a provider VAD may
        # have consumed the buffer already (`input_audio_buffer_commit_empty`,
        # swallowed). In `client` / `hybrid` we also ask for the reply;
        # `provider` mode leaves that to the provider's own VAD endpoint.
        frames: list[dict] = [{"type": "input_audio_buffer.commit"}]
        if turn.endpointing != "provider":
            frames.append({"type": "response.create"})
        return frames
    if kind == "tool-response":
        turn.awaiting.discard(event.get("id", ""))
        # `output` is already a JSON string from the frontend (the realtime
        # `function_call_output.output` contract). The single `response.create`
        # for this round is sent by `_maybe_request_answer`.
        out = event.get("output", "")
        return [
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "function_call_output",
                    "call_id": event.get("id", ""),
                    "output": out if isinstance(out, str) else json.dumps(out),
                },
            }
        ]
    return []


async def _maybe_request_answer(upstream, turn: _RelayTurn) -> None:
    """Send the one follow-up `response.create` once a tool-call round is fully
    resolved — the response that made the calls is done *and* every output is in.
    Idempotent: ``clear_round`` makes a second call a no-op."""
    if turn.follow_up_ready():
        await upstream.send(json.dumps({"type": "response.create"}))
        turn.clear_round()


async def _maybe_break_tool_loop(upstream, turn: _RelayTurn) -> None:
    """A response that keeps calling tools is looping. Cancel it; the outputs so
    far stay in context and ``_maybe_request_answer`` then asks for a plain
    answer once they land."""
    if turn.calls > _MAX_TOOL_CALLS_PER_RESPONSE and not turn.cancelled:
        turn.cancelled = True
        note(f"voice relay: breaking a tool-call loop ({turn.calls} calls in one response)")
        await upstream.send(json.dumps({"type": "response.cancel"}))


# -- the relay ----------------------------------------------------------------


async def _safe_send_json(ws: WebSocket, payload: dict) -> None:
    try:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_json(payload)
    except Exception:  # noqa: BLE001 - best effort; the socket is going away
        pass


async def _pump_client_to_upstream(
    client: WebSocket, upstream, *, ready: asyncio.Event, turn: _RelayTurn
) -> None:
    # Hold the kiosk's audio until the provider has applied our `session.update`
    # (`session.updated`), so early frames aren't processed under the default
    # session (which has server VAD on and could open a turn we then fight).
    try:
        await asyncio.wait_for(ready.wait(), timeout=5)
    except TimeoutError:
        pass
    while True:
        raw = await client.receive_text()
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            continue
        for outgoing in translate_client(frame, turn=turn):
            await upstream.send(json.dumps(outgoing))
        await _maybe_request_answer(upstream, turn)


async def _pump_upstream_to_client(
    client: WebSocket, upstream, *, ready: asyncio.Event, turn: _RelayTurn
) -> None:
    async for raw in upstream:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "session.updated":
            ready.set()
        if kind == "error":
            note(f"voice relay: upstream error {json.dumps(event.get('error', event))}")
        elif kind == "conversation.item.input_audio_transcription.failed":
            note(
                "voice relay: user transcription failed "
                f"{json.dumps(event.get('error', {}))} — check "
                "MISSION_CONTROL_AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT"
            )
        for outgoing in translate_upstream(event, turn):
            await _safe_send_json(client, outgoing)
        await _maybe_break_tool_loop(upstream, turn)
        await _maybe_request_answer(upstream, turn)


def _is_clean_end(exc: BaseException | None) -> bool:
    """A socket on either side closing is a normal end of turn, not a failure."""
    if exc is None or isinstance(exc, WebSocketDisconnect | asyncio.CancelledError):
        return True
    return exc.__class__.__module__.startswith("websockets") and "Closed" in exc.__class__.__name__


async def run_relay(client: WebSocket, config: UpstreamConfig) -> None:
    """Bridge an accepted kiosk socket to the provider until either side closes."""
    import websockets

    try:
        async with websockets.connect(
            config.url, additional_headers=config.headers, max_size=None
        ) as upstream:
            await upstream.send(
                json.dumps({"type": "session.update", "session": config.session_update})
            )
            ready = asyncio.Event()
            turn = _RelayTurn(endpointing=config.endpointing)
            tasks = [
                asyncio.create_task(
                    _pump_client_to_upstream(client, upstream, ready=ready, turn=turn)
                ),
                asyncio.create_task(
                    _pump_upstream_to_client(client, upstream, ready=ready, turn=turn)
                ),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                exc = task.exception()
                if not _is_clean_end(exc):
                    await _safe_send_json(client, {"type": "error", "message": str(exc)})
    except Exception as exc:  # noqa: BLE001 - surface any connect/relay failure to the kiosk
        await _safe_send_json(client, {"type": "error", "message": f"voice relay failed: {exc}"})
    finally:
        await _safe_send_json(client, {"type": "closing"})
        try:
            if client.application_state == WebSocketState.CONNECTED:
                await client.close()
        except Exception:  # noqa: BLE001
            pass
