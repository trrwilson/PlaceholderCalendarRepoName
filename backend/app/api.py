import ipaddress
from datetime import date, datetime, timedelta
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

import app.calendar.personal_auth as personal_auth
from app.calendar.provider import CalendarProvider, MockCalendarProvider
from app.config import get_settings
from app.lists import get_list_store
from app.models import (
    ApplicationMessage,
    CalendarAuthStatus,
    CalendarRange,
    CalendarSnapshot,
    GroceryList,
    ListClearRequest,
    ListItemCreateRequest,
    ListItemUpdateRequest,
    ListMutationResult,
    ListReorderRequest,
    ListRestoreRequest,
    PrivacyState,
    PrivacyUnlockRequest,
    Timer,
    TimerCreateRequest,
    TimerExtendRequest,
    TimerMutationResult,
    TimerState,
    VoiceConfig,
    VoiceConfigUpdate,
    VoiceDebugCapture,
    VoiceDebugCaptureStored,
    VoiceProviderInfo,
    VoiceToken,
    VoiceTokenRequest,
    WakeConfigUpdate,
    WakeProviderInfo,
    WakeWordConfig,
)
from app.privacy import get_privacy_store
from app.realtime import connections
from app.timers import TimerError, get_timer_store
from app.voice import VoiceUnavailable, get_voice_token, reset_voice_token_cache
from app.voice.base import PROVIDER_LABELS
from app.voice.debug_capture import VoiceCaptureError, store_capture
from app.voice.local.interpreter import LocalInterpretRequest
from app.voice.providers import (
    effective_provider,
    implemented_providers,
    provider_configured,
    set_provider_override,
)
from app.voice.relay import redeem_ticket, run_relay
from app.voice.wake import (
    WAKE_PROVIDER_LABELS,
    effective_invoke_gate_enabled,
    effective_wake_provider,
    implemented_wake_providers,
    invoke_gate_configured,
    set_invoke_gate_enabled_override,
    set_wake_provider_override,
    wake_provider_configured,
)

router = APIRouter(prefix="/api")


@lru_cache
def _build_provider() -> CalendarProvider:
    settings = get_settings()
    if settings.calendar_provider == "graph":
        from app.calendar.graph import MicrosoftGraphCalendarProvider

        return MicrosoftGraphCalendarProvider(settings)
    if settings.calendar_provider == "outlook_personal":
        from app.calendar.outlook_personal import PersonalOutlookCalendarProvider

        return PersonalOutlookCalendarProvider(settings)
    return MockCalendarProvider()


def get_provider() -> CalendarProvider:
    return _build_provider()


def _is_local_client(host: str) -> bool:
    if get_settings().allow_remote_auth:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def _require_local(request: Request) -> None:
    """Gate the calendar sign-in endpoints to loopback / LAN unless opted out."""
    host = request.client.host if request.client else ""
    if not _is_local_client(host):
        raise HTTPException(
            status_code=403,
            detail="this endpoint is only available on the local network",
        )


def _require_unlocked() -> None:
    """The single read-only gate for privacy mode.

    Every endpoint that changes household data or configuration calls this after
    ``_require_local``. While privacy mode is locked it returns **423 Locked** —
    so a new mutating endpoint inherits the gate simply by adding this line (see
    ``docs/privacy-mode-plan.md`` and the Definition of Done). Voice *sessions*
    are deliberately not gated here: the assistant stays reachable and refuses
    individual commands instead (``frontend/src/voice/tools.ts``).
    """
    if get_privacy_store().locked:
        raise HTTPException(
            status_code=423, detail="privacy mode is on — unlock the display to make changes"
        )


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/calendar", response_model=CalendarSnapshot)
async def get_calendar(
    starts_on: date | None = None,
    ends_on: date | None = None,
    calendar_provider: CalendarProvider = Depends(get_provider),
) -> CalendarSnapshot:
    start = starts_on or date.today().replace(day=1)
    end = ends_on or (start + timedelta(days=41))
    try:
        calendar_range = CalendarRange(starts_on=start, ends_on=end)
    except ValidationError as exc:
        message = "; ".join(error["msg"] for error in exc.errors())
        raise HTTPException(status_code=422, detail=message) from exc
    return calendar_provider.snapshot(calendar_range)


# -- calendar sign-in (outlook_personal provider) -----------------------------
# Sync `def` handlers: FastAPI runs them in a threadpool, and both MSAL and the
# QR generator do blocking work.


@router.get("/calendar/auth", response_model=CalendarAuthStatus)
def calendar_auth_status(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    settings = get_settings()
    if settings.calendar_provider != "outlook_personal":
        return CalendarAuthStatus(provider=settings.calendar_provider, state="not_applicable")
    return personal_auth.get_status(settings)


@router.post("/calendar/auth/device", response_model=CalendarAuthStatus)
def calendar_auth_begin(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    _require_unlocked()
    settings = get_settings()
    if settings.calendar_provider != "outlook_personal":
        raise HTTPException(status_code=409, detail="calendar provider is not 'outlook_personal'")
    return personal_auth.begin_sign_in(settings)


@router.delete("/calendar/auth/device", response_model=CalendarAuthStatus)
def calendar_auth_cancel(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    _require_unlocked()
    return personal_auth.cancel_sign_in(get_settings())


@router.delete("/calendar/auth", response_model=CalendarAuthStatus)
def calendar_auth_signout(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    _require_unlocked()
    settings = get_settings()
    if settings.calendar_provider != "outlook_personal":
        raise HTTPException(status_code=409, detail="calendar provider is not 'outlook_personal'")
    return personal_auth.sign_out(settings)


@router.post("/voice/token", response_model=VoiceToken)
async def voice_token(
    request: Request,
    body: VoiceTokenRequest | None = None,
    calendar_provider: CalendarProvider = Depends(get_provider),
) -> VoiceToken:
    """Hand the kiosk a constrained ephemeral token for its Gemini Live session.

    Backed by two caches (``app/voice/cache.py``): the calendar snapshot the
    system prompt is built from, and the minted token itself. A cached token is
    re-served only until the next event boundary / local midnight / staleness cap,
    so the agent never reasons from a "what's next" that has gone out of date.
    """
    from app.voice.trace import note

    _require_local(request)
    note("token request received")
    try:
        return await get_voice_token(get_settings(), calendar_provider, body)
    except VoiceUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _voice_config() -> VoiceConfig:
    settings = get_settings()
    implemented = set(implemented_providers())
    return VoiceConfig(
        enabled=settings.voice_enabled,
        provider=effective_provider(settings),
        mic_input_gain_db=settings.mic_input_gain_db,
        providers=[
            VoiceProviderInfo(
                id=pid,
                label=label,
                implemented=pid in implemented,
                configured=provider_configured(settings, pid),
            )
            for pid, label in PROVIDER_LABELS.items()
        ],
    )


@router.get("/voice/config", response_model=VoiceConfig)
def voice_config(request: Request) -> VoiceConfig:
    """Which conversational voice provider is active, and which the kiosk could
    switch to. Always safe to call; ``enabled`` is false until
    ``MISSION_CONTROL_VOICE_ENABLED``."""
    _require_local(request)
    return _voice_config()


@router.put("/voice/config", response_model=VoiceConfig)
def set_voice_config(request: Request, body: VoiceConfigUpdate) -> VoiceConfig:
    """Point every subsequent turn at ``body.provider`` (bake-off A/B control).

    Process-memory only — a restart reverts to ``MISSION_CONTROL_VOICE_PROVIDER``.
    The token cache is cleared so a grant for the previous provider is not
    re-served.
    """
    _require_local(request)
    _require_unlocked()
    try:
        set_provider_override(body.provider)
    except VoiceUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    reset_voice_token_cache()
    return _voice_config()


@router.websocket("/voice/live")
async def voice_live_relay(websocket: WebSocket) -> None:
    """Relay for the Azure voice contestants: the kiosk connects here with the
    single-use ticket from its grant, and the backend bridges to the provider,
    translating both directions to the shared ``VoiceEvent`` protocol
    (``app/voice/relay.py``). Loopback / LAN only, like every other voice route.
    """
    host = websocket.client.host if websocket.client else ""
    if not _is_local_client(host):
        await websocket.close(code=4403)
        return
    config = redeem_ticket(websocket.query_params.get("ticket"))
    if config is None:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    try:
        await run_relay(websocket, config)
    except WebSocketDisconnect:
        return


def _wake_config() -> WakeWordConfig:
    settings = get_settings()
    implemented = set(implemented_wake_providers())
    return WakeWordConfig(
        enabled=settings.wake_word_enabled and settings.voice_enabled,
        phrase=settings.wake_word_phrase,
        threshold=settings.wake_word_threshold,
        cooldown_ms=settings.wake_word_cooldown_ms,
        provider=effective_wake_provider(settings),
        providers=[
            WakeProviderInfo(
                id=pid,
                label=label,
                implemented=pid in implemented,
                configured=wake_provider_configured(settings, pid),
            )
            for pid, label in WAKE_PROVIDER_LABELS.items()
        ],
        model_path=settings.wake_word_model_path,
        models_base_url=settings.wake_word_models_base_url,
        invoke_gate_configured=invoke_gate_configured(settings),
        invoke_gate_enabled=effective_invoke_gate_enabled(settings),
        invoke_gate_host=settings.wake_word_invoke_gate_host,
        invoke_gate_audio_port=settings.wake_word_invoke_gate_audio_port,
        invoke_gate_control_port=settings.wake_word_invoke_gate_control_port,
    )


@router.get("/voice/wake-config", response_model=WakeWordConfig)
def voice_wake_config(request: Request) -> WakeWordConfig:
    """Wake-word settings for the kiosk: the active detection back end, the ones
    it could switch to, and the thresholds / asset locations the in-browser
    detector needs.

    ``openwakeword`` detection is entirely browser-side; ``azure`` detection
    runs on the backend (``WS /api/voice/wake/azure``). Always safe to call —
    ``enabled`` is false until both voice and wake word are switched on.
    """
    _require_local(request)
    return _wake_config()


@router.put("/voice/wake-config", response_model=WakeWordConfig)
def set_voice_wake_config(request: Request, body: WakeConfigUpdate) -> WakeWordConfig:
    """Adjust the wake-word bake-off at runtime (orthogonal to the
    conversational-provider switch). A request may set the detection
    ``provider``, the ``invoke_gate_gating`` switch, or both.

    Process-memory only — a restart reverts to the ``MISSION_CONTROL_WAKE_WORD_*``
    defaults.
    """
    _require_local(request)
    _require_unlocked()
    if body.provider is not None:
        try:
            set_wake_provider_override(body.provider)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    if body.invoke_gate_enabled is not None:
        set_invoke_gate_enabled_override(body.invoke_gate_enabled)
    return _wake_config()


@router.websocket("/voice/wake/azure")
async def voice_wake_azure(websocket: WebSocket) -> None:
    """Backend keyword spotting for the ``azure`` wake provider: the kiosk
    streams 16 kHz mic PCM here and the backend spots the phrase offline with
    the native Speech SDK (``app/voice/wake_azure.py``). Loopback / LAN only,
    like every other voice route.
    """
    host = websocket.client.host if websocket.client else ""
    if not _is_local_client(host):
        await websocket.close(code=4403)
        return
    settings = get_settings()
    if not (settings.wake_word_enabled and settings.voice_enabled):
        await websocket.close(code=4404)
        return
    if not wake_provider_configured(settings, "azure"):
        await websocket.close(code=4404)
        return
    await websocket.accept()
    from app.voice.wake_azure import run_wake_relay

    try:
        await run_wake_relay(websocket)
    except WebSocketDisconnect:
        return


@router.websocket("/voice/wake/invoke")
async def voice_wake_invoke(websocket: WebSocket) -> None:
    """Bridge the on-device ``invoke-gate`` control socket to the kiosk for the
    additive Invoke gate (``app/voice/wake_invoke.py``). The daemon's audio
    still reaches the kiosk over VB-CABLE; only the control channel is relayed.
    Loopback / LAN only, like every other voice route.
    """
    host = websocket.client.host if websocket.client else ""
    if not _is_local_client(host):
        await websocket.close(code=4403)
        return
    settings = get_settings()
    if not (settings.wake_word_enabled and settings.voice_enabled):
        await websocket.close(code=4404)
        return
    if not invoke_gate_configured(settings):
        await websocket.close(code=4404)
        return
    await websocket.accept()
    from app.voice.wake_invoke import run_invoke_wake_relay

    try:
        await run_invoke_wake_relay(websocket)
    except WebSocketDisconnect:
        return


@router.post("/voice/debug/capture", response_model=VoiceDebugCaptureStored)
def voice_debug_capture(request: Request, body: VoiceDebugCapture) -> VoiceDebugCaptureStored:
    """Persist one retained voice activation's audio to disk for debugging.

    The kiosk POSTs the headered WAV it streamed to the speech provider for a
    turn; the backend writes it (plus a ``.json`` sidecar) under
    ``MISSION_CONTROL_VOICE_DEBUG_CAPTURE_DIR`` and prunes to
    ``…_KEEP`` pairs. LAN-gated; 409 when voice or the capture is switched off.
    """
    _require_local(request)
    settings = get_settings()
    if not settings.voice_enabled:
        raise HTTPException(status_code=409, detail="voice support is disabled")
    if not settings.voice_debug_capture_enabled:
        raise HTTPException(status_code=409, detail="voice debug capture is disabled")
    try:
        path = store_capture(settings, body)
    except VoiceCaptureError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return VoiceDebugCaptureStored(path=str(path))


# -- local / hybrid voice pipeline (experimental) ---------------------------
# On-device STT + intent/entity interpretation; cloud only for genuine
# reasoning. See app/voice/local/ and docs/local-voice-plan.md. Nothing here
# touches the Gemini or Azure paths.


def _local_snapshot(provider: CalendarProvider):
    """A fresh [today, +voice_context_days] snapshot for the interpreter — called
    per turn. Matches the window the cloud prompt digest covers so a loose
    reference resolves the same way on either path."""
    today = date.today()
    days = max(get_settings().voice_context_days, 1)
    return provider.snapshot(CalendarRange(starts_on=today, ends_on=today + timedelta(days=days)))


@router.websocket("/voice/local")
async def voice_local_pipeline(websocket: WebSocket) -> None:
    """The Local / Hybrid contestant's transport.

    The kiosk connects with the single-use ticket from its grant and drives the
    turn with the same uplink frames the Azure relay uses (plus a ``text`` frame
    for the microphone-free bypass). The backend runs local speech recognition
    and interpretation and emits shared ``VoiceEvent`` JSON — including
    ``diagnostic`` and ``escalation`` events. LAN-only, like every voice route.
    """
    from app.voice.local.engines import create_recognizer
    from app.voice.local.session import (
        get_recognizer,
        redeem_local_ticket,
        run_local_pipeline,
    )

    host = websocket.client.host if websocket.client else ""
    if not _is_local_client(host):
        await websocket.close(code=4403)
        return
    config = redeem_local_ticket(websocket.query_params.get("ticket"))
    if config is None:
        await websocket.close(code=4401)
        return

    settings = get_settings()
    client_time = websocket.query_params.get("client_time")

    def now_fn() -> datetime:
        if client_time:
            try:
                return datetime.fromisoformat(client_time).replace(tzinfo=None)
            except ValueError:
                pass
        return datetime.now()

    provider = get_provider()
    await websocket.accept()
    try:
        recognizer = await get_recognizer(lambda: create_recognizer(settings))
    except Exception as exc:  # noqa: BLE001 - report and fall back to text bypass
        await websocket.send_json(
            {"type": "error", "message": f"local speech engine unavailable: {exc}"}
        )
        from app.voice.local.engines.scripted import ScriptedRecognizer

        recognizer = ScriptedRecognizer()
    try:
        await run_local_pipeline(
            websocket,
            config,
            recognizer=recognizer,
            snapshot_fn=lambda: _local_snapshot(provider),
            now_fn=now_fn,
        )
    except WebSocketDisconnect:
        return


@router.post("/voice/local/interpret")
def voice_local_interpret(request: Request, body: LocalInterpretRequest):
    """Run the semantic layer over a text utterance — no microphone, no model.

    The direct way to exercise / test intent + entity resolution and the
    local-vs-escalate decision (``docs/local-voice-plan.md`` -> "Bypassing
    voice"). LAN-gated; always available (independent of ``voice_enabled``).
    """
    from datetime import datetime as _dt

    from app.voice.local.adapter import LocalHybridAdapter
    from app.voice.local.session import run_interpretation

    _require_local(request)
    settings = get_settings()
    now = _dt.now()
    if body.client_time:
        try:
            now = _dt.fromisoformat(body.client_time).replace(tzinfo=None)
        except ValueError:
            pass
    snapshot = _local_snapshot(get_provider())
    cfg = LocalHybridAdapter()._interpreter_config(settings)
    interp = run_interpretation(
        body.text,
        now=now,
        snapshot=snapshot,
        config=cfg,
        timer_active=body.timer_active,
        stt_confidence=body.stt_confidence,
    )
    return interp.model_dump(mode="json")


# -- timers ------------------------------------------------------------------
# Backend-owned, in-memory, one active timer for now (see docs/timer-plan.md).
# Gated to loopback / LAN like the other control surfaces. Every mutation returns
# the resulting Timer *and* broadcasts, so the initiating kiosk and any other
# screen converge through the same path.


@router.get("/timers", response_model=list[Timer])
async def list_timers(request: Request) -> list[Timer]:
    _require_local(request)
    return get_timer_store().list_timers()


@router.post("/timers", response_model=TimerMutationResult)
async def create_timer(request: Request, body: TimerCreateRequest) -> TimerMutationResult:
    _require_local(request)
    _require_unlocked()
    try:
        return await get_timer_store().create(body)
    except TimerError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/timers/{timer_id}", response_model=Timer)
async def extend_timer(request: Request, timer_id: str, body: TimerExtendRequest) -> Timer:
    _require_local(request)
    _require_unlocked()
    try:
        return await get_timer_store().extend(timer_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such timer") from exc
    except TimerError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/timers/{timer_id}", status_code=204)
async def delete_timer(request: Request, timer_id: str) -> None:
    """Cancel a running timer or dismiss a fired one — same call for both."""
    _require_local(request)
    # Privacy mode blocks every mutation *except* silencing a timer that is
    # already going off — that is quieting an appliance, not touching household
    # data (docs/privacy-mode-plan.md, resolution 2).
    if get_privacy_store().locked:
        current = next((t for t in get_timer_store().list_timers() if t.id == timer_id), None)
        if current is None or current.state is not TimerState.fired:
            raise HTTPException(
                status_code=423, detail="privacy mode is on — unlock the display to make changes"
            )
    try:
        await get_timer_store().cancel(timer_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such timer") from exc


@router.post("/timers/{timer_id}/pause", response_model=Timer)
async def pause_timer(request: Request, timer_id: str) -> Timer:
    """Hold the countdown, freezing the time that is left until a resume."""
    _require_local(request)
    _require_unlocked()
    try:
        return await get_timer_store().pause(timer_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such timer") from exc
    except TimerError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/timers/{timer_id}/resume", response_model=Timer)
async def resume_timer(request: Request, timer_id: str) -> Timer:
    """Continue a paused timer from where it stopped."""
    _require_local(request)
    _require_unlocked()
    try:
        return await get_timer_store().resume(timer_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such timer") from exc
    except TimerError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/timers/{timer_id}/restart", response_model=Timer)
async def restart_timer(request: Request, timer_id: str) -> Timer:
    """Reset the timer to its full duration and start counting again."""
    _require_local(request)
    _require_unlocked()
    try:
        return await get_timer_store().restart(timer_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such timer") from exc


# -- lists ------------------------------------------------------------------
# Backend-owned, persisted to one JSON file (unlike timers — a wall appliance
# that forgets the grocery list on reboot is broken UX). One list for now
# (`grocery`), keyed by id. Gated to loopback / LAN. Every mutation returns the
# resulting state (with `removed` for an on-screen Undo) *and* broadcasts, so
# every screen converges. See docs/lists-plan.md.


@router.get("/lists", response_model=list[GroceryList])
async def list_lists(request: Request) -> list[GroceryList]:
    _require_local(request)
    return get_list_store().list_all()


@router.get("/lists/{list_id}", response_model=GroceryList)
async def get_list(request: Request, list_id: str) -> GroceryList:
    _require_local(request)
    current = get_list_store().get(list_id)
    if current is None:
        raise HTTPException(status_code=404, detail="no such list")
    return current


@router.post("/lists/{list_id}/items", response_model=ListMutationResult)
async def add_list_items(
    request: Request, list_id: str, body: ListItemCreateRequest
) -> ListMutationResult:
    _require_local(request)
    _require_unlocked()
    try:
        return await get_list_store().add_items(
            list_id, body.resolved_names(), note=body.note, source=body.source
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such list") from exc


@router.patch("/lists/{list_id}/items/{item_id}", response_model=ListMutationResult)
async def update_list_item(
    request: Request, list_id: str, item_id: str, body: ListItemUpdateRequest
) -> ListMutationResult:
    _require_local(request)
    _require_unlocked()
    try:
        return await get_list_store().update_item(list_id, item_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such list or item") from exc


@router.delete("/lists/{list_id}/items/{item_id}", response_model=ListMutationResult)
async def remove_list_item(request: Request, list_id: str, item_id: str) -> ListMutationResult:
    _require_local(request)
    _require_unlocked()
    try:
        return await get_list_store().remove_item(list_id, item_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such list or item") from exc


@router.post("/lists/{list_id}/clear", response_model=ListMutationResult)
async def clear_list(request: Request, list_id: str, body: ListClearRequest) -> ListMutationResult:
    """Clear the checked items (default) or everything. `removed` powers Undo."""
    _require_local(request)
    _require_unlocked()
    try:
        return await get_list_store().clear(list_id, body.scope)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such list") from exc


@router.post("/lists/{list_id}/restore", response_model=ListMutationResult)
async def restore_list(
    request: Request, list_id: str, body: ListRestoreRequest
) -> ListMutationResult:
    """Re-insert items a clear / remove took off — the Undo path."""
    _require_local(request)
    _require_unlocked()
    try:
        return await get_list_store().restore(list_id, body.items)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such list") from exc


@router.post("/lists/{list_id}/reorder", response_model=ListMutationResult)
async def reorder_list(
    request: Request, list_id: str, body: ListReorderRequest
) -> ListMutationResult:
    """Apply a custom drag-reorder of the list; the new order is persisted."""
    _require_local(request)
    _require_unlocked()
    try:
        return await get_list_store().reorder(list_id, body.item_ids)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such list") from exc


# -- privacy mode ----------------------------------------------------------
# A household-global "redact the specifics + read-only" state for a houseguest.
# Entered with no secret (the safe direction); left only by the configured PIN on
# the on-screen keypad. Persisted, broadcast over /api/ws. Every mutating
# endpoint above calls _require_unlocked(); voice stays reachable but refuses
# individual commands. Social barrier, not a security control. See
# docs/privacy-mode-plan.md.


@router.get("/privacy", response_model=PrivacyState)
async def get_privacy(request: Request) -> PrivacyState:
    _require_local(request)
    return get_privacy_store().state()


@router.post("/privacy/lock", response_model=PrivacyState)
async def privacy_lock(request: Request) -> PrivacyState:
    """Enter privacy mode. No secret — this is the safe direction. Idempotent."""
    _require_local(request)
    store = get_privacy_store()
    if not store.available:
        raise HTTPException(
            status_code=409, detail="privacy mode has no unlock PIN configured on this display"
        )
    return await store.lock()


@router.post("/privacy/unlock", response_model=PrivacyState)
async def privacy_unlock(request: Request, body: PrivacyUnlockRequest) -> PrivacyState:
    """Leave privacy mode by entering the configured PIN."""
    _require_local(request)
    store = get_privacy_store()
    outcome = await store.unlock(body.pin)
    if outcome == "ok":
        return store.state()
    if outcome == "disabled":
        raise HTTPException(status_code=409, detail="privacy mode is not configured")
    if outcome == "locked-out":
        raise HTTPException(
            status_code=429,
            detail="too many attempts — wait before trying again",
            headers={"Retry-After": str(store.cooldown_remaining())},
        )
    raise HTTPException(status_code=401, detail="that PIN is not right")


@router.post("/privacy/unlock/grace", response_model=PrivacyState)
async def privacy_unlock_grace(request: Request) -> PrivacyState:
    """The no-PIN undo, valid only for a few seconds after privacy mode is
    entered — covers an accidental or prank toggle."""
    _require_local(request)
    store = get_privacy_store()
    if not await store.undo():
        raise HTTPException(status_code=410, detail="the undo window has passed — enter the PIN")
    return store.state()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    connections.add(websocket)
    try:
        await websocket.send_json(
            {"type": "connected", "message": "Dashboard live connection ready"}
        )
        # Send the current timer list so a just-loaded / just-reconnected kiosk is
        # immediately correct (a restart cleared them → the kiosk clears too).
        await websocket.send_json(
            ApplicationMessage(
                type="timers",
                message="current timers",
                timers=get_timer_store().list_timers(),
            ).model_dump(mode="json", exclude_none=True)
        )
        # ...and the current lists (these persist across a restart).
        await websocket.send_json(
            ApplicationMessage(
                type="lists",
                message="current lists",
                lists=get_list_store().list_all(),
            ).model_dump(mode="json", exclude_none=True)
        )
        # ...and whether privacy mode is on (also persisted).
        await websocket.send_json(
            ApplicationMessage(
                type="privacy",
                message="current privacy state",
                privacy=get_privacy_store().state(),
            ).model_dump(mode="json", exclude_none=True)
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        return
    finally:
        connections.discard(websocket)
