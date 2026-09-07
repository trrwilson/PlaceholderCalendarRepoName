"""The local voice pipeline: one kiosk WebSocket turn, end to end.

``WS /api/voice/local`` accepts the same uplink frames the Azure relay does
(``audio`` / ``activity-start`` / ``activity-end`` / ``tool-response``) plus a
``text`` frame for the wake-word-free, microphone-free bypass. It emits the
shared ``VoiceEvent`` JSON the frontend ``ConversationalVoiceProvider`` already
consumes, plus two local-only events:

* ``diagnostic`` — the full interpretation trace (observability);
* ``escalation`` — a Tier-2 / unknown request the local layer punts, with only
  the structured context a cloud text model would need. Actually calling a cloud
  model is an explicit extension point (``CloudEscalator``), not wired here.

Tool *execution* stays in the browser through the existing dispatcher — the
pipeline only decides which tools to call, exactly as a cloud provider's model
would (``AGENTS.md`` -> "tools are explicit application tools, never providers").
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime

from fastapi.concurrency import run_in_threadpool
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from app.models import CalendarSnapshot
from app.voice.local.interpreter import Disposition, Interpretation, InterpreterConfig, interpret
from app.voice.local.recognizer import RecognitionEvent, SpeechRecognizer
from app.voice.trace import note

# -- ticket store (single-use, like app/voice/relay.py) -----------------------


@dataclass
class LocalPipelineConfig:
    interpreter: InterpreterConfig
    engine_label: str
    diagnostics: bool = True


@dataclass
class _Ticket:
    config: LocalPipelineConfig
    expires_at: float


_TICKETS: dict[str, _Ticket] = {}


def issue_local_ticket(config: LocalPipelineConfig, ttl_seconds: int) -> str:
    _prune()
    token = secrets.token_urlsafe(24)
    _TICKETS[token] = _Ticket(config, time.monotonic() + ttl_seconds)
    return token


def redeem_local_ticket(token: str | None) -> LocalPipelineConfig | None:
    _prune()
    if not token:
        return None
    ticket = _TICKETS.pop(token, None)
    if ticket is None or ticket.expires_at < time.monotonic():
        return None
    return ticket.config


def reset_local_tickets() -> None:
    _TICKETS.clear()


def _prune() -> None:
    now = time.monotonic()
    for token in [t for t, tk in _TICKETS.items() if tk.expires_at < now]:
        _TICKETS.pop(token, None)


# -- shared recogniser (expensive to build; one per process) ------------------

_recognizer: SpeechRecognizer | None = None
_recognizer_lock = asyncio.Lock()


async def get_recognizer(build: callable) -> SpeechRecognizer:
    """Build the configured recogniser once and reuse it (model load is slow)."""
    global _recognizer
    if _recognizer is None:
        _recognizer = await run_in_threadpool(build)
    return _recognizer


def reset_recognizer() -> None:
    global _recognizer
    if _recognizer is not None:
        try:
            _recognizer.close()
        except Exception:  # noqa: BLE001
            pass
    _recognizer = None


# -- interpretation entry point (shared with POST .../local/interpret) --------

# Intents whose answer is *spoken*, not shown — the pipeline waits for the tool
# result and templates a reply (there is no local TTS; the VoiceOverlay shows it).
_AWAIT_RESULT_INTENTS = {"timer.query", "calendar.conflicts"}


def run_interpretation(
    transcript: str,
    *,
    now: datetime,
    snapshot: CalendarSnapshot,
    config: InterpreterConfig,
    timer_active: bool = False,
    stt_confidence: float | None = None,
) -> Interpretation:
    return interpret(
        transcript,
        now=now,
        snapshot=snapshot,
        config=config,
        timer_active=timer_active,
        stt_confidence=stt_confidence,
    )


# -- the WebSocket turn loop -------------------------------------------------


@dataclass
class _TurnState:
    recognizer: SpeechRecognizer
    config: LocalPipelineConfig
    snapshot_fn: callable
    now_fn: callable
    timer_active: bool = False
    audio_bytes: int = 0
    finalized: bool = False
    partial_seen: bool = False
    tool_results: dict[str, dict] = field(default_factory=dict)
    pending_tools: set[str] = field(default_factory=set)
    tool_wait: asyncio.Event = field(default_factory=asyncio.Event)


async def _send(ws: WebSocket, payload: dict) -> None:
    try:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_json(payload)
    except Exception:  # noqa: BLE001 - socket going away
        pass


async def _emit_recognition(
    ws: WebSocket, events: list[RecognitionEvent], state: _TurnState
) -> str | None:
    """Forward partial/final transcripts; return a final transcript if one landed."""
    final: str | None = None
    final_conf: float | None = None
    for ev in events:
        if ev.type == "partial" and ev.text:
            state.partial_seen = True
            await _send(ws, {"type": "user-transcript", "text": ev.text, "final": False})
        elif ev.type == "final":
            final = ev.text
            final_conf = ev.confidence
        elif ev.type == "error":
            await _send(ws, {"type": "error", "message": ev.message or "speech recognition failed"})
    if final is not None:
        state._final_confidence = final_conf  # type: ignore[attr-defined]
    return final


async def _handle_turn_end(
    ws: WebSocket, state: _TurnState, *, injected_text: str | None = None
) -> None:
    if state.finalized:
        return
    state.finalized = True

    if injected_text is not None:
        transcript = injected_text
        stt_conf: float | None = getattr(state, "_injected_confidence", None)
        stt_timings: dict = {}
    else:
        started = time.perf_counter()
        events = await run_in_threadpool(state.recognizer.finalize)
        final = await _emit_recognition(ws, events, state)
        transcript = final or ""
        stt_conf = getattr(state, "_final_confidence", None)
        stt_timings = state.recognizer.timings.as_dict()
        stt_timings["finalize_wall_ms"] = round((time.perf_counter() - started) * 1000, 1)

    await _send(ws, {"type": "user-transcript", "text": transcript, "final": True})

    if not transcript.strip():
        await _send(ws, {"type": "waiting-for-input"})
        await _send(ws, {"type": "generation-complete"})
        await _send(ws, {"type": "turn-complete"})
        return

    now = state.now_fn()
    snapshot = await run_in_threadpool(state.snapshot_fn)
    interp = await run_in_threadpool(
        run_interpretation,
        transcript,
        now=now,
        snapshot=snapshot,
        config=state.config.interpreter,
        timer_active=state.timer_active,
        stt_confidence=stt_conf,
    )
    interp.timings_ms = {
        **interp.timings_ms,
        **{f"stt_{k}": v for k, v in stt_timings.items() if v is not None},
    }

    if state.config.diagnostics:
        await _send(
            ws,
            {
                "type": "diagnostic",
                "stage": "interpretation",
                "data": interp.model_dump(mode="json"),
            },
        )
    note(
        f"local voice: {interp.disposition.value} intent={interp.intent} "
        f"conf={interp.confidence} tools={[t.name for t in interp.tool_calls]}"
    )

    await _dispatch(ws, state, interp)


async def _dispatch(ws: WebSocket, state: _TurnState, interp: Interpretation) -> None:
    if interp.disposition == Disposition.escalate_to_cloud:
        await _send(
            ws,
            {
                "type": "escalation",
                "reason": interp.reason,
                "tier": interp.tier,
                "payload": interp.escalation or {},
            },
        )
        # No cloud text model is wired in this experiment — see CloudEscalator.
        spoken = interp.speech or "Let me pass that to the full assistant."
        await _send(ws, {"type": "assistant-transcript", "text": spoken})
        await _send(ws, {"type": "generation-complete"})
        await _send(ws, {"type": "turn-complete"})
        return

    if interp.disposition in (Disposition.needs_clarification, Disposition.rejected):
        text = interp.clarification or interp.speech or "I can't do that yet."
        await _send(ws, {"type": "assistant-transcript", "text": text})
        await _send(ws, {"type": "generation-complete"})
        await _send(ws, {"type": "turn-complete"})
        return

    # handled_locally — fire the tool calls the kiosk will execute.
    ids: list[str] = []
    for call in interp.tool_calls:
        call_id = f"local-{secrets.token_hex(4)}"
        ids.append(call_id)
        state.pending_tools.add(call_id)
        await _send(ws, {"type": "tool-call", "id": call_id, "name": call.name, "args": call.args})

    speech = interp.speech
    if interp.intent in _AWAIT_RESULT_INTENTS and ids:
        try:
            await asyncio.wait_for(state.tool_wait.wait(), timeout=4.0)
        except TimeoutError:
            pass
        speech = _templated_reply(interp, state.tool_results) or speech

    if speech:
        await _send(ws, {"type": "assistant-transcript", "text": speech})
    await _send(ws, {"type": "generation-complete"})
    await _send(ws, {"type": "turn-complete"})


def _templated_reply(interp: Interpretation, results: dict[str, dict]) -> str | None:
    """A spoken answer for the few intents where the display does not carry it."""
    payloads = list(results.values())
    if interp.intent == "timer.query":
        data = next((p for p in payloads if "running" in p or "firing" in p), None)
        if not data:
            return "I couldn't reach the timer."
        if data.get("firing"):
            return "The timer is going off right now."
        mins = data.get("remaining_minutes")
        label = data.get("label")
        tail = f" for {label}" if label else ""
        plural = "s" if mins != 1 else ""
        if data.get("paused"):
            return f"The timer is paused with about {mins} minute{plural} left{tail}."
        if not data.get("running"):
            return "There's no timer running."
        return f"About {mins} minute{plural} left{tail}."
    if interp.intent == "calendar.conflicts":
        data = next((p for p in payloads if "has_conflicts" in p), None)
        if not data:
            return interp.speech
        if not data.get("has_conflicts"):
            return "Nothing's double-booked."
        clashes = data.get("conflicts") or []
        first = clashes[0] if clashes else {}
        return f"Yes — {first.get('a', 'two events')} clashes with {first.get('b', 'another')}."
    return None


async def run_local_pipeline(
    websocket: WebSocket,
    config: LocalPipelineConfig,
    *,
    recognizer: SpeechRecognizer,
    snapshot_fn: callable,
    now_fn: callable,
) -> None:
    """Drive one kiosk connection until it closes. One turn per connection
    (mirrors ``AGENTS.md`` -> "One session per turn")."""
    recognizer.reset()
    state = _TurnState(recognizer=recognizer, config=config, snapshot_fn=snapshot_fn, now_fn=now_fn)
    await _send(websocket, {"type": "open"})

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = frame.get("type")

            if kind == "audio":
                data = frame.get("data", "")
                if not data or state.finalized:
                    continue
                import base64

                try:
                    pcm = base64.b64decode(data)
                except Exception:  # noqa: BLE001
                    continue
                state.audio_bytes += len(pcm)
                events = await run_in_threadpool(state.recognizer.accept_audio, pcm)
                final = await _emit_recognition(websocket, events, state)
                if final is not None:
                    # A streaming engine detected its own endpoint — use the
                    # transcript it already produced rather than finalize()ing again.
                    state._injected_confidence = getattr(state, "_final_confidence", None)  # type: ignore[attr-defined]
                    await _handle_turn_end(websocket, state, injected_text=final)
            elif kind == "activity-start":
                continue
            elif kind == "activity-end":
                await _handle_turn_end(websocket, state)
            elif kind == "text":
                text = str(frame.get("text", "")).strip()
                conf = frame.get("confidence")
                if isinstance(conf, (int, float)):
                    state._injected_confidence = float(conf)  # type: ignore[attr-defined]
                state.timer_active = bool(frame.get("timer_active", state.timer_active))
                await _handle_turn_end(websocket, state, injected_text=text)
            elif kind == "timer-state":
                state.timer_active = bool(frame.get("active", False))
            elif kind == "tool-response":
                call_id = frame.get("id", "")
                out = frame.get("output")
                parsed: dict
                if isinstance(out, str):
                    try:
                        parsed = json.loads(out)
                    except json.JSONDecodeError:
                        parsed = {"raw": out}
                elif isinstance(out, dict):
                    parsed = out
                else:
                    parsed = {}
                state.tool_results[call_id] = parsed
                state.pending_tools.discard(call_id)
                if not state.pending_tools:
                    state.tool_wait.set()
    except (WebSocketDisconnect, RuntimeError):
        return
