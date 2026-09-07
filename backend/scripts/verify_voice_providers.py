"""Live connectivity check for the bake-off voice providers.

Runs the *exact* handshake the relay (``app/voice/relay.py``) would: build the
grant for a provider, open the upstream WebSocket, send ``session.update``, and
wait for ``session.updated`` / ``session.created``. Optionally pushes ~0.5 s of
silence and asks for a response to confirm the turn lifecycle.

    cd backend
    ./.venv/Scripts/python -m scripts.verify_voice_providers            # all providers
    ./.venv/Scripts/python -m scripts.verify_voice_providers gemini     # just one
    ./.venv/Scripts/python -m scripts.verify_voice_providers --turn     # + a dummy turn

Reads the same settings as the app (``backend/.env`` + environment), so set the
endpoints and ``FOUNDRY_API_KEY_MC_EASTUS2`` first. Nothing here is used at
runtime; it just exercises the adapters.
"""

from __future__ import annotations

import asyncio
import base64
import json
import math
import struct
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on the path

from starlette.websockets import WebSocketState  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.voice.base import VoiceUnavailable  # noqa: E402
from app.voice.providers import _adapter_for, implemented_providers  # noqa: E402
from app.voice.relay import redeem_ticket, run_relay  # noqa: E402

_RATE = 24_000


def _tone_chunk_100ms(t0: float, freq: float = 220.0, amp: float = 0.25) -> str:
    """100 ms of a sine tone as base64 PCM16 mono 24 kHz — a stand-in for speech."""
    n = _RATE // 10
    samples = [int(amp * 32767 * math.sin(2 * math.pi * freq * (t0 + i / _RATE))) for i in range(n)]
    return base64.b64encode(struct.pack(f"<{n}h", *samples)).decode()


async def _check(provider: str, *, do_turn: bool, verbose: bool) -> bool:
    settings = get_settings()
    try:
        adapter = _adapter_for(provider)
    except VoiceUnavailable as exc:
        print(f"  SKIP  {provider}: {exc}")
        return True

    if reason := adapter.missing_config(settings):
        print(f"  SKIP  {provider}: {reason}")
        return True

    grant = await adapter.create_grant(
        settings,
        calendar_names=["Alex", "Sam"],
        surface="verify",
        now_local=datetime.now(),
        timezone="America/New_York",
    )

    if grant.provider == "gemini":
        print(f"  OK    gemini: minted a token for {grant.model} on {grant.api_version}")
        return True

    import websockets

    cfg = redeem_ticket(grant.token)
    assert cfg is not None
    print(f"  ...   {provider}: connecting {cfg.url.split('?')[0]}?…")
    try:
        async with websockets.connect(
            cfg.url, additional_headers=cfg.headers, max_size=None, open_timeout=20
        ) as ws:
            await ws.send(json.dumps({"type": "session.update", "session": cfg.session_update}))
            ok = await _await_session(ws)
            if ok and do_turn:
                await _dummy_turn(ws, verbose=verbose)
        return ok
    except Exception as exc:  # noqa: BLE001 - report any failure verbatim
        print(f"  FAIL  {provider}: {type(exc).__name__}: {exc}")
        return False


async def _await_session(ws) -> bool:
    while True:
        event = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
        kind = event.get("type")
        if kind in ("session.updated", "session.created"):
            print(f"  OK    {kind}")
            return True
        if kind == "error":
            print(f"  FAIL  error: {json.dumps(event.get('error', event))}")
            return False
        print(f"        (…{kind})")


async def _dummy_turn(ws, *, verbose: bool) -> None:
    """Mimic a kiosk turn: stream ~1.5 s of tone in 100 ms chunks, then commit +
    response.create. Logs every event so a hang or empty response is diagnosable.
    (A tone is not speech, so any user transcript / VAD will be empty — that's
    expected; the point is that a response comes back.)"""
    reader = asyncio.create_task(_drain(ws, verbose=verbose))
    for i in range(15):
        await ws.send(
            json.dumps({"type": "input_audio_buffer.append", "audio": _tone_chunk_100ms(i * 0.1)})
        )
        await asyncio.sleep(0.1)
    await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
    await ws.send(json.dumps({"type": "response.create"}))
    try:
        await asyncio.wait_for(reader, timeout=30)
    except TimeoutError:
        reader.cancel()
        print("  FAIL  no response.done within 30 s — the turn hung")


async def _drain(ws, *, verbose: bool) -> None:
    got_audio = False
    while True:
        event = json.loads(await ws.recv())
        kind = event.get("type")
        if kind in ("response.output_audio.delta", "response.audio.delta"):
            if not got_audio:
                got_audio = True
                print("  OK    first response audio chunk")
            continue
        if kind == "error":
            print(f"  ERROR {json.dumps(event.get('error', event))}")
            continue
        if kind == "response.done":
            resp = event.get("response", {})
            print(
                f"  DONE  status={resp.get('status')} "
                f"details={json.dumps(resp.get('status_details'))} "
                f"outputs={[o.get('type') for o in resp.get('output', [])]}"
            )
            return
        if verbose:
            print(f"        {kind}")


class _FakeClient:
    """Stands in for the kiosk WebSocket so `run_relay` can be driven directly —
    this exercises `translate_upstream` / `translate_client`, unlike the raw
    upstream check above."""

    def __init__(self) -> None:
        self.application_state = WebSocketState.CONNECTED
        self._inbox: asyncio.Queue[str | None] = asyncio.Queue()
        self.received: list[dict] = []

    async def receive_text(self) -> str:
        item = await self._inbox.get()
        if item is None:
            from starlette.websockets import WebSocketDisconnect

            raise WebSocketDisconnect(1000)
        return item

    async def send_json(self, payload: dict) -> None:
        self.received.append(payload)
        kind = payload.get("type")
        if kind == "audio":
            print("  RELAY OK  forwarded an `audio` VoiceEvent")
        elif kind == "tool-call":
            print(f"  RELAY     -> tool-call {payload.get('name')} — auto-answering")
            self.feed(
                {
                    "type": "tool-response",
                    "id": payload.get("id", ""),
                    "name": payload.get("name", ""),
                    # `output` is a serialised string, matching the frontend.
                    "output": json.dumps({"ok": True, "events": []}),
                }
            )
        elif kind not in ("open",):
            print(
                f"  RELAY     -> {kind}"
                + (f" {payload.get('message', '')}" if kind == "error" else "")
            )

    def feed(self, frame: dict) -> None:
        self._inbox.put_nowait(json.dumps(frame))

    def hangup(self) -> None:
        self._inbox.put_nowait(None)

    async def close(self, code: int = 1000) -> None:
        self.application_state = WebSocketState.DISCONNECTED


async def _relay_turn(provider: str) -> bool:
    settings = get_settings()
    adapter = _adapter_for(provider)
    if reason := adapter.missing_config(settings):
        print(f"  SKIP  {provider}: {reason}")
        return True
    grant = await adapter.create_grant(
        settings,
        calendar_names=["Alex", "Sam"],
        surface="verify",
        now_local=datetime.now(),
        timezone="America/New_York",
    )
    cfg = redeem_ticket(grant.token)
    assert cfg is not None
    client = _FakeClient()
    relay = asyncio.create_task(run_relay(client, cfg))

    async def drive() -> None:
        client.feed({"type": "activity-start"})
        for i in range(15):
            client.feed({"type": "audio", "data": _tone_chunk_100ms(i * 0.1)})
            await asyncio.sleep(0.1)
        client.feed({"type": "activity-end"})
        # Wait out the two-phase response (speak -> tools -> answer), then hang up.
        for _ in range(30):
            await asyncio.sleep(1)
            if any(f["type"] == "turn-complete" for f in client.received):
                break
        client.hangup()

    await drive()
    try:
        await asyncio.wait_for(relay, timeout=10)
    except TimeoutError:
        relay.cancel()

    kinds = [f["type"] for f in client.received]
    audio = kinds.count("audio")
    transcripts = kinds.count("assistant-transcript")
    tools = kinds.count("tool-call")
    gen = "generation-complete" in kinds
    print(
        f"  RESULT {provider}: audio={audio} assistant-transcript={transcripts} "
        f"tool-call={tools} generation-complete={gen}"
    )
    ok = audio > 0 and gen
    print(f"  {'OK' if ok else 'FAIL'}   relay forwarded the response" if True else "")
    return ok


async def _main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    do_turn = "--turn" in sys.argv
    verbose = "--verbose" in sys.argv
    providers = args or list(implemented_providers())

    if "--relay" in sys.argv:
        print(f"Relay turn for: {', '.join(providers)}\n")
        results = [await _relay_turn(p) for p in providers if p != "gemini"]
        print()
        return 0 if all(results) else 1

    print(f"Verifying: {', '.join(providers)}  (turn={do_turn})\n")
    results = [await _check(p, do_turn=do_turn, verbose=verbose) for p in providers]
    print()
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
